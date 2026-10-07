import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Pool, type QueryConfig } from "pg";
import type { DistributedJob, RewardAllocation, RewardClaim, RewardEpoch } from "@/domain/types";
import { Breaker } from "./failsoft";
import { KeyedMutex, type DocKind, type DocQuery, type NetworkStore, type StoredChallenge, type StoredJob, type StoredNode, type WorkAggregate, type WorkRecord } from "./store";

/** Postgres implementation of NetworkStore. Schema: db/schema.sql. */
/** Content hash of schema.sql: the DDL re-runs only when the file changes. */
function schemaVersion(sql: string) {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

export class PgStore implements NetworkStore {
  private pool: Pool;
  /**
   * Separate, smaller pool for advisory-lock clients. A lock holder pins one client for the whole
   * critical section while the work inside it queries through `pool`; sharing one pool lets N lock
   * holders exhaust it and every query on the instance (including read-only routes) waits forever.
   */
  private lockPool: Pool;
  private ready: Promise<void>;
  constructor(connectionString: string) {
    // Hosted Postgres (Supabase, Neon, Prisma) requires TLS; local docker usually has none.
    // Hosted providers terminate TLS with their own CA, so `sslmode=require` in the URL must not
    // turn into full chain verification (pg ≥ 8.16 does that). We strip it and set ssl explicitly.
    const local = /localhost|127\.0\.0\.1/.test(connectionString);
    let cs = connectionString;
    try {
      const u = new URL(connectionString);
      u.searchParams.delete("sslmode");
      u.searchParams.delete("ssl");
      cs = u.toString();
      this.portNum = u.port ? Number(u.port) : 5432;
    } catch {
      /* not a URL-shaped string; pass through */
    }
    const ssl = local ? undefined : { rejectUnauthorized: false };
    // Fail fast rather than hang: a serverless instance that cannot get a connection in 8s or finish
    // a statement in 15s should return an error, not hold the request open until the platform kills it.
    // Behind Supabase/pgbouncer the whole project shares a few hundred client slots, and every warm
    // serverless instance holds its idle connections, so per-instance pools stay small. But every
    // reconnect is a TLS handshake plus pooler auth, and with a 2 s idle timeout the instances were
    // reconnecting on nearly every request: `SELECT 1` measured 6 s under load. Hold sockets for 45 s.
    const common = { connectionString: cs, ssl, connectionTimeoutMillis: 8_000, idleTimeoutMillis: 45_000, allowExitOnIdle: true, statement_timeout: 15_000, query_timeout: 15_000 };
    this.pool = new Pool({ ...common, max: 3 });
    this.lockPool = new Pool({ ...common, max: 2 });
    // Idle-client errors (pooler closing a socket) must not become unhandled rejections that kill the instance.
    for (const pool of [this.pool, this.lockPool]) pool.on("error", (e) => console.warn("[pgStore] idle client error:", e.message));
    this.ready = this.migrate();
  }

  /**
   * Apply db/schema.sql once per process. Every statement is `IF NOT EXISTS`, so this is idempotent
   * and safe to run concurrently from several instances. Lets a fresh database bootstrap itself when
   * the connection string is only available at runtime (e.g. Vercel "sensitive" env vars).
   */
  private async migrate() {
    if (process.env.BRAIN_SKIP_MIGRATE === "true") return;
    const file = path.join(process.cwd(), "db", "schema.sql");
    let sql: string;
    try {
      sql = readFileSync(file, "utf8");
    } catch {
      return; // schema not shipped with this build; assume it was applied out of band
    }
    try {
      // One cheap read decides whether the DDL needs to run at all. Every cold start used to replay
      // all fifteen IF NOT EXISTS statements (catalog locks on busy tables, hundreds of times a day).
      const version = schemaVersion(sql);
      let marker: string | null = null;
      try {
        const r = await this.pool.query<{ v: string }>(`SELECT data->>'version' AS v FROM brain_documents WHERE kind = 'meta' AND id = 'schema' LIMIT 1`);
        marker = r.rows[0]?.v ?? null;
      } catch (e) {
        // Database not answering: tell the breaker and stop here. Replaying the DDL would just be
        // another 8 s connect timeout on every cold start during an outage.
        if (this.breaker.failure(e)) {
          this.migrationError = (e as Error).message;
          return;
        }
        marker = null; // table missing on a fresh database: run the DDL
      }
      if (marker === version) return;
      await this.pool.query(sql);
      await this.pool.query(
        `INSERT INTO brain_documents (kind, id, key, at, data) VALUES ('meta', 'schema', NULL, $1, $2) ON CONFLICT (kind, id) DO UPDATE SET at = $1, data = $2`,
        [Date.now(), JSON.stringify({ version, appliedAt: Date.now() })],
      );
      // Advisory locks held for more than a minute belong to a frozen or dead instance. Clear them.
      await this.pool.query(
        `SELECT pg_terminate_backend(a.pid) FROM pg_locks l JOIN pg_stat_activity a USING (pid)
         WHERE l.locktype = 'advisory' AND a.pid <> pg_backend_pid() AND a.state_change < now() - interval '60 seconds'`,
      );
      // Work aggregates from before they had a statement timeout can run for many minutes and starve
      // everything else. Anything from this app older than a minute is stale by definition (results are
      // cached per minute); end it.
      await this.pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
           AND now() - query_start > interval '60 seconds' AND query LIKE '%SELECT assigned_to AS node_id, status%'`,
      );
    } catch (e) {
      this.migrationError = (e as Error).message;
      console.error("[pgStore] schema migration failed:", (e as Error).message);
    }
  }

  /**
   * One breaker per instance: when the database stops accepting connections, two failures open it
   * and every query for the next 15 s fails in microseconds with StoreUnavailableError (503) instead
   * of each waiting its own 8 s connect timeout. One probe per window closes it again.
   */
  private breaker = new Breaker({ threshold: 2, openMs: 15_000 });

  /** Pool query gated on the schema being applied and on the breaker. */
  private q<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) {
    return this.breaker.run(async () => {
      await this.ready;
      return this.pool.query<T>(text, params);
    });
  }

  /** Whether this instance is currently refusing database work. For status views only. */
  unavailable() {
    return this.breaker.open;
  }

  private mutex = new KeyedMutex();
  /**
   * In-process mutex (cheap, covers the common case) plus a Postgres advisory lock so that several
   * server instances sharing one database also serialize on the same key.
   */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(key, async () => {
      await this.ready;
      // Transaction-scoped advisory lock on a dedicated client. Session-level locks are unusable
      // behind transaction-mode poolers (Supabase/pgbouncer): lock and unlock can land on different
      // backends and the lock leaks forever. A transaction is pinned to one backend and the lock
      // is released at COMMIT no matter what.
      const c = await this.breaker.run(() => this.lockPool.connect());
      let locked = false;
      let clean = false;
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL lock_timeout = '3s'");
        try {
          await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
          locked = true;
        } catch (e) {
          console.warn(`[pgStore] lock ${key} not acquired (${(e as Error).message}); continuing with in-process lock only`);
          clean = await c.query("ROLLBACK").then(() => true, () => false);
        }
        return await fn();
      } finally {
        if (locked) {
          clean = await c
            .query("COMMIT")
            .then(() => true)
            .catch(() => c.query("ROLLBACK").then(() => true, () => false));
        }
        // A client whose transaction was not demonstrably closed is destroyed rather than pooled.
        c.release(clean ? undefined : new Error("transaction state unknown"));
      }
    });
  }

  /** Which backend is serving, for operational views. */
  /** Which port the connection string targets (5432 direct/session pooler, 6543 transaction pooler). Never the host or credentials. */
  port(): number | null {
    return this.portNum;
  }
  private portNum: number | null = null;
  private migrationError: string | null = null;

  /**
   * Aggregate health facts for operators and the public status page. Contains no row data, no
   * credentials and no hostnames: table sizes, dead-row counts, connection counts, slow statements.
   */
  async diagnostics() {
    const t0 = Date.now();
    await this.q("SELECT 1");
    const pingMs = Date.now() - t0;
    const [tables, conns, slow, idx, settings, active, dbStats] = await Promise.all([
      this.q<{ relname: string; live: string; dead: string; bytes: string; last_autovacuum: string | null; last_autoanalyze: string | null }>(
        `SELECT relname, n_live_tup::text AS live, n_dead_tup::text AS dead, pg_total_relation_size(relid)::text AS bytes,
                last_autovacuum::text, last_autoanalyze::text
           FROM pg_stat_user_tables WHERE relname LIKE 'brain_%' ORDER BY pg_total_relation_size(relid) DESC`,
      ),
      this.q<{ state: string | null; n: string }>(`SELECT coalesce(state, 'other') AS state, count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1`),
      this.q<{ n: string; oldest_s: string | null }>(
        `SELECT count(*)::text AS n, extract(epoch FROM max(now() - query_start))::int::text AS oldest_s
           FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid() AND now() - query_start > interval '2 seconds'`,
      ),
      this.q<{ tablename: string; indexname: string }>(`SELECT tablename, indexname FROM pg_indexes WHERE tablename LIKE 'brain_%' ORDER BY 1, 2`),
      this.q<{ name: string; setting: string }>(`SELECT name, setting FROM pg_settings WHERE name IN ('max_connections', 'server_version', 'shared_buffers', 'work_mem')`),
      this.q<{ state: string | null; wait: string | null; secs: string; xact_secs: string | null; query: string }>(
        `SELECT state, wait_event_type || ':' || wait_event AS wait, extract(epoch FROM now() - query_start)::numeric(10,1)::text AS secs,
                extract(epoch FROM now() - xact_start)::numeric(10,1)::text AS xact_secs, left(regexp_replace(query, '\\s+', ' ', 'g'), 110) AS query
           FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state IS NOT NULL AND state <> 'idle'
          ORDER BY query_start LIMIT 25`,
      ),
      this.q<{ xact: string; hit: string; read: string; reset: string | null }>(
        `SELECT xact_commit::text AS xact, blks_hit::text AS hit, blks_read::text AS read, stats_reset::text AS reset FROM pg_stat_database WHERE datname = current_database()`,
      ),
    ]);
    const db = dbStats.rows[0];
    let statements: { calls: number; meanMs: number; totalS: number; rows: number; query: string }[] | null = null;
    try {
      const r = await this.q<{ calls: string; mean_exec_time: string; total_exec_time: string; rows: string; query: string }>(
        `SELECT calls::text, mean_exec_time::text, total_exec_time::text, rows::text, left(query, 140) AS query
           FROM pg_stat_statements WHERE query LIKE '%brain_%' AND query NOT LIKE '%pg_stat%'
          ORDER BY total_exec_time DESC LIMIT 10`,
      );
      statements = r.rows.map((x) => ({ calls: Number(x.calls), meanMs: Math.round(Number(x.mean_exec_time) * 10) / 10, totalS: Math.round(Number(x.total_exec_time) / 100) / 10, rows: Number(x.rows), query: x.query.replace(/\s+/g, " ") }));
    } catch {
      statements = null; // extension not enabled
    }
    let schema: { applied: string | null; expected: string | null } = { applied: null, expected: null };
    try {
      const sql = readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8");
      const r = await this.q<{ v: string }>(`SELECT data->>'version' AS v FROM brain_documents WHERE kind = 'meta' AND id = 'schema' LIMIT 1`);
      schema = { applied: r.rows[0]?.v ?? null, expected: schemaVersion(sql) };
    } catch {
      /* schema file not shipped */
    }
    return {
      pingMs,
      port: this.port(),
      schema,
      migrationError: this.migrationError,
      tables: tables.rows.map((x) => ({ table: x.relname, liveRows: Number(x.live), deadRows: Number(x.dead), mb: Math.round(Number(x.bytes) / 1048576), lastAutovacuum: x.last_autovacuum, lastAutoanalyze: x.last_autoanalyze })),
      connections: Object.fromEntries(conns.rows.map((x) => [x.state ?? "other", Number(x.n)])),
      slowActive: { count: Number(slow.rows[0]?.n ?? 0), oldestSeconds: slow.rows[0]?.oldest_s == null ? null : Number(slow.rows[0].oldest_s) },
      indexes: idx.rows.map((x) => `${x.tablename}.${x.indexname}`),
      settings: Object.fromEntries(settings.rows.map((x) => [x.name, x.setting])),
      // In-flight sessions: what is holding pooler server connections right now (parameterized SQL only; no row data).
      active: active.rows.map((x) => ({ state: x.state, wait: x.wait, seconds: Number(x.secs), txSeconds: x.xact_secs == null ? null : Number(x.xact_secs), query: x.query })),
      database: db ? { transactions: Number(db.xact), cacheHitRatio: Number(db.hit) + Number(db.read) > 0 ? Math.round((Number(db.hit) / (Number(db.hit) + Number(db.read))) * 1000) / 1000 : null, statsSince: db.reset } : null,
      statements,
    };
  }

  kind() {
    return "postgres" as const;
  }

  async saveNode(n: StoredNode) {
    await this.q(
      `INSERT INTO brain_nodes (id, session_hash, status, data, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE SET session_hash = $2, status = $3, data = $4, updated_at = now()`,
      [n.id, n.sessionHash, n.status, JSON.stringify(n)],
    );
  }
  async getNode(id: string) {
    const r = await this.q(`SELECT data FROM brain_nodes WHERE id = $1`, [id]);
    return (r.rows[0]?.data as StoredNode) ?? null;
  }
  async getNodes(ids: string[]) {
    const out = new Map<string, StoredNode>();
    if (ids.length === 0) return out;
    const r = await this.q(`SELECT id, data FROM brain_nodes WHERE id = ANY($1::text[])`, [ids]);
    for (const row of r.rows) out.set(row.id as string, row.data as StoredNode);
    return out;
  }
  async getNodeBySession(sessionHash: string) {
    const r = await this.q(`SELECT data FROM brain_nodes WHERE session_hash = $1`, [sessionHash]);
    return (r.rows[0]?.data as StoredNode) ?? null;
  }
  async listNodes() {
    const r = await this.q(`SELECT data FROM brain_nodes WHERE updated_at > now() - interval '1 day'`);
    return r.rows.map((x) => x.data as StoredNode);
  }
  async countNodesJoined() {
    const r = await this.q(`SELECT count(DISTINCT coalesce(data->>'identityHash', id))::int AS n FROM brain_nodes`);
    return Number(r.rows[0]?.n ?? 0);
  }
  async saveJob(j: StoredJob) {
    await this.q(
      `INSERT INTO brain_jobs (id, assigned_to, status, submitted_at, data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET status = $3, data = $5`,
      [j.id, j.assignedTo, j.status, j.submittedAt, JSON.stringify(j)],
    );
  }
  async getJob(id: string) {
    const r = await this.q(`SELECT data FROM brain_jobs WHERE id = $1`, [id]);
    return (r.rows[0]?.data as StoredJob) ?? null;
  }
  /** Same table as kernel jobs so aggregateWork sees one population; rows are terminal on insert. */
  async recordWork(w: WorkRecord) {
    await this.q(
      `INSERT INTO brain_jobs (id, assigned_to, status, submitted_at, data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET status = $3, data = $5`,
      [w.id, w.assignedTo, w.status, w.submittedAt, JSON.stringify(w)],
    );
  }
  async getWork(id: string) {
    const r = await this.q(`SELECT data FROM brain_jobs WHERE id = $1 AND data->>'source' = 'native-inference'`, [id]);
    return (r.rows[0]?.data as WorkRecord) ?? null;
  }
  async listRecentJobs(limit: number) {
    const r = await this.q(`SELECT data FROM brain_jobs ORDER BY submitted_at DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => x.data as StoredJob);
  }
  async pendingJobFor(nodeId: string) {
    const r = await this.q(
      `SELECT data FROM brain_jobs WHERE assigned_to = $1 AND status = 'assigned' LIMIT 1`,
      [nodeId],
    );
    return (r.rows[0]?.data as StoredJob) ?? null;
  }
  async nextJobNumber() {
    const r = await this.q(`SELECT nextval('brain_job_seq') AS n`);
    return Number(r.rows[0].n);
  }
  async saveChallenge(c: StoredChallenge) {
    await this.q(
      `INSERT INTO brain_challenges (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2`,
      [c.id, JSON.stringify(c)],
    );
  }
  async getChallenge(id: string) {
    const r = await this.q(`SELECT data FROM brain_challenges WHERE id = $1`, [id]);
    return (r.rows[0]?.data as StoredChallenge) ?? null;
  }
  /**
   * The most expensive query in the system: a 24 h epoch is hundreds of thousands of job rows grouped
   * with array_agg(DISTINCT …). Under load, dozens of viewers each triggered one (per wallet page, per
   * serverless instance), they spilled to disk at the default 5 MB work_mem and ran for minutes with
   * no effective statement timeout behind the transaction pooler. That took the database down.
   *
   * Now: results are cached in brain_documents at one-minute granularity so every instance shares one
   * computation per minute (closed windows: one per day); an in-process single-flight memo stops one
   * instance running it twice; the query itself runs in a transaction with SET LOCAL so the timeout
   * and work_mem actually apply on the pooled backend.
   */
  async aggregateWork(from: number, to: number, bucketMs: number) {
    const now = Date.now();
    const closed = to <= now - 3_600_000;
    const slotMs = closed ? 86_400_000 : 60_000;
    const key = `agg:${from}:${closed ? to : "live"}:${bucketMs}:${Math.floor(now / slotMs)}`;
    const memo = this.aggMemo.get(key);
    if (memo) return memo;
    const p = (async () => {
      const hit = await this.getDoc<{ rows: WorkAggregate[] }>("meta", key).catch(() => null);
      if (hit?.rows) return hit.rows;
      const rows = await this.aggregateWorkUncached(from, closed ? to : now, bucketMs);
      await this.putDoc("meta", key, { rows, from, to: closed ? to : now, bucketMs }, { at: now }).catch(() => undefined);
      return rows;
    })();
    this.aggMemo.set(key, p);
    p.catch(() => this.aggMemo.delete(key));
    // Memo lives for the slot; keep the map from growing.
    setTimeout(() => this.aggMemo.delete(key), slotMs).unref?.();
    if (this.aggMemo.size > 64) this.aggMemo.delete(this.aggMemo.keys().next().value as string);
    return p;
  }
  private aggMemo = new Map<string, Promise<WorkAggregate[]>>();

  private async aggregateWorkUncached(from: number, to: number, bucketMs: number) {
    await this.ready;
    const c = await this.breaker.run(() => this.pool.connect());
    let failed: Error | undefined;
    try {
      await c.query("BEGIN");
      // SET LOCAL survives the transaction pooler (the whole transaction is pinned to one backend).
      await c.query("SET LOCAL statement_timeout = '30s'");
      await c.query("SET LOCAL work_mem = '64MB'");
      // The pool's client-side query_timeout (15 s) must not cut this one short: pg would reject the
      // promise while the server kept running, and the connection would go back to the pool still
      // inside the transaction. Give the client slightly longer than the server.
      type Row = { node_id: string; status: string; verified: boolean | null; fail_reason: string | null; jobs: number; units: string; buckets: number[] };
      // pg honours a per-query `query_timeout` (lib/client.js) that @types/pg does not declare.
      const cfg: QueryConfig & { query_timeout: number } = {
        text: `/* aggregateWork */ SELECT assigned_to AS node_id, status, (data->>'verified')::boolean AS verified, data->>'failReason' AS fail_reason, count(*)::int AS jobs,
                coalesce(sum((data->>'computeUnits')::numeric), 0)::text AS units,
                array_agg(DISTINCT floor(submitted_at / $3)::bigint) AS buckets
           FROM brain_jobs WHERE submitted_at >= $1 AND submitted_at < $2
          GROUP BY 1, 2, 3, 4`,
        values: [from, to, bucketMs],
        query_timeout: 32_000,
      };
      const r = await c.query<Row>(cfg);
      await c.query("COMMIT");
      return r.rows.map<WorkAggregate>((x) => ({ nodeId: x.node_id, status: x.status, verified: Boolean(x.verified), failReason: x.fail_reason ?? null, jobs: Number(x.jobs), computeUnits: Number(x.units), buckets: x.buckets.map(Number) }));
    } catch (e) {
      failed = e instanceof Error ? e : new Error(String(e));
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      // After any failure the connection is destroyed, not returned: a client whose ROLLBACK did not
      // demonstrably succeed may still be mid-transaction, and one such client in the pool makes every
      // later query on it fail with "current transaction is aborted".
      c.release(failed);
    }
  }
  async listOpenJobs(limit: number, since: number) {
    // Bounded by the recent-index range so this never walks the whole table looking for open rows.
    const r = await this.q(`SELECT data FROM brain_jobs WHERE submitted_at > $2 AND status NOT IN ('completed', 'failed') ORDER BY submitted_at DESC LIMIT $1`, [limit, since]);
    return r.rows.map((x) => x.data as StoredJob);
  }
  async listJobsBetween(from: number, to: number) {
    const r = await this.q(`SELECT data FROM brain_jobs WHERE submitted_at >= $1 AND submitted_at < $2`, [from, to]);
    return r.rows.map((x) => x.data as StoredJob);
  }
  async getEpoch(id: string) {
    const r = await this.q(`SELECT data FROM brain_reward_epochs WHERE id = $1`, [id]);
    return (r.rows[0]?.data as RewardEpoch) ?? null;
  }
  async saveSettlement(epoch: RewardEpoch, allocations: RewardAllocation[]) {
    await this.ready;
    const c = await this.breaker.run(() => this.pool.connect());
    let destroy: Error | undefined;
    try {
      await c.query("BEGIN");
      const ins = await c.query(
        `INSERT INTO brain_reward_epochs (id, starts_at, provenance, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [epoch.id, epoch.startsAt, epoch.provenance, JSON.stringify(epoch)],
      );
      if (ins.rowCount === 0) {
        await c.query("ROLLBACK");
        return false;
      }
      for (const a of allocations) {
        await c.query(`INSERT INTO brain_reward_allocations (epoch_id, wallet, lamports, data) VALUES ($1, $2, $3, $4)`, [
          a.epochId,
          a.wallet,
          a.lamports,
          JSON.stringify(a),
        ]);
      }
      await c.query("COMMIT");
      return true;
    } catch (e) {
      // Destroy rather than pool the client if its transaction cannot be shown closed (see aggregateWorkUncached).
      destroy = await c.query("ROLLBACK").then(() => undefined, (re: unknown) => (re instanceof Error ? re : new Error(String(re))));
      throw e;
    } finally {
      c.release(destroy);
    }
  }
  async listEpochs(limit: number) {
    const r = await this.q(`SELECT data FROM brain_reward_epochs ORDER BY starts_at DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => x.data as RewardEpoch);
  }
  async allocationsForWallet(wallet: string) {
    const r = await this.q(`SELECT data FROM brain_reward_allocations WHERE wallet = $1`, [wallet]);
    return r.rows.map((x) => x.data as RewardAllocation);
  }
  async allocationsForEpoch(epochId: string) {
    const r = await this.q(`SELECT data FROM brain_reward_allocations WHERE epoch_id = $1`, [epochId]);
    return r.rows.map((x) => x.data as RewardAllocation);
  }
  async insertClaim(cl: RewardClaim) {
    try {
      const r = await this.q(
        `INSERT INTO brain_reward_claims (id, wallet, lamports, status, created_at, data) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [cl.id, cl.wallet, cl.lamports, cl.status, cl.createdAt, JSON.stringify(cl)],
      );
      return r.rowCount === 1;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return false;
      throw e;
    }
  }
  async updateClaim(cl: RewardClaim) {
    await this.q(`UPDATE brain_reward_claims SET status = $2, data = $3 WHERE id = $1`, [cl.id, cl.status, JSON.stringify(cl)]);
  }
  async claimsForWallet(wallet: string) {
    const r = await this.q(`SELECT data FROM brain_reward_claims WHERE wallet = $1 ORDER BY created_at DESC`, [wallet]);
    return r.rows.map((x) => x.data as RewardClaim);
  }
  async saveDistributedJob(j: DistributedJob) {
    await this.q(
      `INSERT INTO brain_distributed_jobs (id, status, created_at, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET status = $2, data = $4`,
      [j.id, j.status, j.createdAt, JSON.stringify(j)],
    );
  }
  async getDistributedJob(id: string) {
    const r = await this.q(`SELECT data FROM brain_distributed_jobs WHERE id = $1`, [id]);
    return (r.rows[0]?.data as DistributedJob) ?? null;
  }
  async listDistributedJobs(limit: number) {
    const r = await this.q(`SELECT data FROM brain_distributed_jobs ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => x.data as DistributedJob);
  }
  async pendingUnitsFor(nodeId: string) {
    const r = await this.q(
      `SELECT data FROM brain_jobs WHERE assigned_to = $1 AND status = 'assigned' AND data ? 'parentId'`,
      [nodeId],
    );
    return r.rows.map((x) => x.data as StoredJob);
  }
  async listJobsForNode(nodeId: string, limit: number) {
    const r = await this.q(`SELECT data FROM brain_jobs WHERE assigned_to = $1 ORDER BY submitted_at DESC LIMIT $2`, [nodeId, limit]);
    return r.rows.map((x) => x.data as StoredJob);
  }
  async putDoc<T>(kind: DocKind, id: string, doc: T, index: { at: number; key?: string }) {
    await this.q(
      `INSERT INTO brain_documents (kind, id, key, at, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (kind, id) DO UPDATE SET key = $3, at = $4, data = $5`,
      [kind, id, index.key ?? null, index.at, JSON.stringify(doc)],
    );
  }
  async getDoc<T>(kind: DocKind, id: string) {
    const r = await this.q(`SELECT data FROM brain_documents WHERE kind = $1 AND id = $2`, [kind, id]);
    return (r.rows[0]?.data as T) ?? null;
  }
  async listDocs<T>(kind: DocKind, q: DocQuery = {}) {
    const where = ["kind = $1"];
    const args: unknown[] = [kind];
    if (q.key != null) args.push(q.key), where.push(`key = $${args.length}`);
    if (q.from != null) args.push(q.from), where.push(`at >= $${args.length}`);
    if (q.to != null) args.push(q.to), where.push(`at < $${args.length}`);
    args.push(q.limit ?? 100);
    const r = await this.q(`SELECT data FROM brain_documents WHERE ${where.join(" AND ")} ORDER BY at DESC LIMIT $${args.length}`, args);
    return r.rows.map((x) => x.data as T);
  }
  async findDocByKey<T>(kind: DocKind, key: string) {
    const r = await this.q(`SELECT data FROM brain_documents WHERE kind = $1 AND key = $2 LIMIT 1`, [kind, key]);
    return (r.rows[0]?.data as T) ?? null;
  }
  async claimedSince(since: number) {
    const r = await this.q(`SELECT COALESCE(SUM(lamports), 0) AS s FROM brain_reward_claims WHERE status <> 'failed' AND created_at >= $1`, [since]);
    return Number(r.rows[0].s);
  }
}
