import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Pool, type QueryConfig } from "pg";
import type { DistributedJob, RewardAllocation, RewardClaim, RewardEpoch } from "@/domain/types";
import { Breaker, StoreConflictError, StoreUnavailableError, isPoolerRejection } from "./failsoft";
import { KeyedMutex, MONOTONIC_NODE_COUNTERS, type DocKind, type DocQuery, type NetworkStore, type StoredChallenge, type StoredJob, type StoredNode, type WorkAggregate, type WorkRecord } from "./store";

/** `(jsonb->>'k')::numeric`, 0 when absent. Only ever called with the fixed counter names above. */
const numField = (col: string, key: string) => `coalesce((${col}->>'${key}')::numeric, 0)`;

/** Postgres implementation of NetworkStore. Schema: db/schema.sql. */
/** Content hash of schema.sql: the DDL re-runs only when the file changes. */
function schemaVersion(sql: string) {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

/**
 * One retry, after a short pause, when the pooler itself refused the connection (client cap, or a
 * tenant pool with stale credentials). pg opens a fresh socket for the retry, which usually reaches a
 * healthy pooler node. Anything else propagates untouched.
 */
async function retryPoolerRejection<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isPoolerRejection(e)) throw e;
      console.warn("[pgStore] pooler rejected connection, retrying:", (e as Error).message.slice(0, 80));
      await new Promise((r) => setTimeout(r, 250 * i));
    }
  }
}

/**
 * One way of reaching the database. `pool` serves ordinary queries; `lockPool` is a separate,
 * smaller pool for advisory-lock clients: a lock holder pins one client for the whole critical
 * section while the work inside it queries through `pool`, and sharing one pool let N lock holders
 * exhaust it so every query on the instance (including read-only routes) waited forever.
 */
type Lane = { name: string; mode: "transaction" | "session" | "direct"; pool: Pool; lockPool: Pool; badUntil: number };

export class PgStore implements NetworkStore {
  /**
   * Ordered ways of reaching the database; the first lane that is not cooling down serves.
   *
   * Supabase's transaction-mode pooler (port 6543) intermittently poisons the pool it keeps for one
   * database role and then rejects every connection for that role with "Authentication credentials
   * are invalid … reconnect with fresh credentials", although the credentials are unchanged and the
   * same credentials work on the session-mode pooler (5432). The poison is per role: another role's
   * pool on the same pooler keeps working. So:
   *   1. primary   – DATABASE_URL, transaction pooler
   *   2. alternate – DATABASE_URL_ALT, a second role with the same grants, transaction pooler
   *   3. session   – the primary URL on port 5432 (Supabase pooler URLs only). Session mode admits
   *                  at most pool_size clients for the whole project (15 on small compute), so this
   *                  lane is a last resort: one client per pool, released after 3 s idle.
   * A lane that rejects goes on cooldown and the next one serves; a poisoned pooler pool that sits
   * idle for the cooldown is rebuilt with fresh credentials when traffic returns to it.
   */
  private lanes: Lane[];
  private static readonly LANE_COOLDOWN_MS = 10 * 60_000;
  /** How long withLock keeps retrying the advisory lock before proceeding under the in-process lock only. */
  private static readonly LOCK_WAIT_MS = 8_000;
  private ready: Promise<void>;
  constructor(connectionString: string, alternateConnectionString?: string) {
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
    const common = { ssl, connectionTimeoutMillis: 8_000, idleTimeoutMillis: 45_000, allowExitOnIdle: true, statement_timeout: 15_000, query_timeout: 15_000 };
    const lane = (name: string, mode: Lane["mode"], connectionString: string, opts: { max: number; lockMax: number; idleTimeoutMillis?: number }): Lane => {
      const cfg = { ...common, connectionString, ...(opts.idleTimeoutMillis ? { idleTimeoutMillis: opts.idleTimeoutMillis } : {}) };
      const l: Lane = { name, mode, pool: new Pool({ ...cfg, max: opts.max }), lockPool: new Pool({ ...cfg, max: opts.lockMax }), badUntil: 0 };
      // Idle-client errors (pooler closing a socket) must not become unhandled rejections that kill the instance.
      for (const pool of [l.pool, l.lockPool]) pool.on("error", (e) => console.warn(`[pgStore] idle client error (${name}):`, e.message));
      return l;
    };
    const supabasePooler = (s: string) => {
      try {
        const u = new URL(s);
        return /\.pooler\.supabase\.com$/.test(u.hostname) && u.port === "6543" ? u : null;
      } catch {
        return null;
      }
    };
    this.lanes = [lane("primary", this.portNum === 6543 ? "transaction" : "direct", cs, { max: 3, lockMax: 4 })];
    if (alternateConnectionString && alternateConnectionString !== connectionString) {
      try {
        const u = new URL(alternateConnectionString);
        u.searchParams.delete("sslmode");
        u.searchParams.delete("ssl");
        this.lanes.push(lane("alternate", u.port === "6543" ? "transaction" : "direct", u.toString(), { max: 3, lockMax: 4 }));
      } catch {
        console.warn("[pgStore] DATABASE_URL_ALT is not a URL; ignored");
      }
    }
    const sessionUrl = supabasePooler(cs);
    if (sessionUrl) {
      sessionUrl.port = "5432";
      this.lanes.push(lane("session", "session", sessionUrl.toString(), { max: 1, lockMax: 1, idleTimeoutMillis: 3_000 }));
    }
    // BRAIN_PG_LANE_ORDER="alternate,primary" puts a known-good lane first. Every cold serverless
    // instance otherwise pays the poisoned primary's connect timeout (and a retry) before it learns
    // to cool it down, which is a 8–16 s first query on each new instance; node agents heartbeating
    // on a 15 s budget read that as the coordinator being gone.
    const order = (process.env.BRAIN_PG_LANE_ORDER ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (order.length) {
      const rank = (l: Lane) => (order.indexOf(l.name) === -1 ? order.length : order.indexOf(l.name));
      this.lanes.sort((a, b) => rank(a) - rank(b));
    }
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
        const r = await this.viaLane((l) => l.pool.query<{ v: string }>(`SELECT data->>'version' AS v FROM brain_documents WHERE kind = 'meta' AND id = 'schema' LIMIT 1`));
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
      // One instance applies the DDL; the rest skip. Without this, every cold start after a schema
      // change replayed the file at once, and the table locks the replays take (even IF NOT EXISTS
      // statements lock what they check) queued behind live inserts and then blocked all of them:
      // heartbeats waited over a minute on a deploy. Transaction-scoped so the lock, the DDL and the
      // marker travel together on one pinned backend, and a 5 s lock_timeout so a replay that cannot
      // get its locks gives way instead of convoying; the next cold start tries again.
      const c = await this.viaLane((l) => l.pool.connect());
      let applied = false;
      try {
        await c.query("BEGIN");
        const got = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('brain:migrate')) AS ok");
        if (got.rows[0]?.ok) {
          const again = await c.query<{ v: string }>(`SELECT data->>'version' AS v FROM brain_documents WHERE kind = 'meta' AND id = 'schema' LIMIT 1`).catch(() => ({ rows: [] as { v: string }[] }));
          if (again.rows[0]?.v !== version) {
            await c.query("SET LOCAL lock_timeout = '5s'");
            await c.query("SET LOCAL statement_timeout = '60s'");
            await c.query(sql);
            await c.query(
              `INSERT INTO brain_documents (kind, id, key, at, data) VALUES ('meta', 'schema', NULL, $1, $2) ON CONFLICT (kind, id) DO UPDATE SET at = $1, data = $2`,
              [Date.now(), JSON.stringify({ version, appliedAt: Date.now() })],
            );
            applied = true;
          }
        }
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
      if (!applied) return;
      // Advisory locks held for more than a minute belong to a frozen or dead instance. Clear them.
      await this.viaLane((l) => l.pool.query(
        `SELECT pg_terminate_backend(a.pid) FROM pg_locks l JOIN pg_stat_activity a USING (pid)
         WHERE l.locktype = 'advisory' AND a.pid <> pg_backend_pid() AND a.state_change < now() - interval '60 seconds'`,
      ));
      // Work aggregates from before they had a statement timeout can run for many minutes and starve
      // everything else. Anything from this app older than a minute is stale by definition (results are
      // cached per minute); end it.
      await this.viaLane((l) => l.pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
           AND now() - query_start > interval '60 seconds' AND query LIKE '%SELECT assigned_to AS node_id, status%'`,
      ));
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

  /** Lanes that are not cooling down, in preference order; the primary alone when every lane is. */
  private openLanes() {
    const now = Date.now();
    const open = this.lanes.filter((l) => l.badUntil <= now);
    return open.length ? open : [this.lanes[0]];
  }

  /**
   * Run `run` on the first open lane. A lane whose pooler rejects the connection (poisoned pool,
   * client cap) goes on cooldown and the next lane is tried. Any other error propagates untouched:
   * a failing statement is the same on every lane.
   */
  private async viaLane<T>(run: (lane: Lane) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const lane of this.openLanes()) {
      try {
        return await retryPoolerRejection(() => run(lane));
      } catch (e) {
        if (!isPoolerRejection(e)) throw e;
        lane.badUntil = Date.now() + PgStore.LANE_COOLDOWN_MS;
        console.warn(`[pgStore] ${lane.name} lane (${lane.mode} pooler) rejecting connections; cooling down ${PgStore.LANE_COOLDOWN_MS / 1000}s:`, (e as Error).message.slice(0, 100));
        last = e;
      }
    }
    throw last;
  }

  /** Pool query gated on the schema being applied and on the breaker. */
  private q<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) {
    return this.breaker.run(async () => {
      await this.ready;
      return this.viaLane((lane) => lane.pool.query<T>(text, params));
    });
  }

  /** Which pooler mode this instance is on right now. For operational views only. */
  poolerMode(): "transaction" | "session" | "direct" {
    return this.openLanes()[0].mode;
  }

  /** Lane names and whether each is cooling down. For operational views only; no hosts or credentials. */
  laneStatus() {
    const now = Date.now();
    return this.lanes.map((l) => ({ name: l.name, mode: l.mode, coolingDownSec: l.badUntil > now ? Math.ceil((l.badUntil - now) / 1000) : 0 }));
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
      const c = await this.breaker.run(() => this.viaLane((lane) => lane.lockPool.connect()));
      let locked = false;
      let clean = true;
      try {
        // Up to 64 units of one job return within the same second from different instances, each
        // wanting this lock for a read-modify-write of the parent. Waiting inside a transaction
        // (pg_advisory_xact_lock) pins a pooler backend per waiter; with sixteen waiters the role's
        // whole backend quota was pinned, the holder's own queries could not get a backend to finish,
        // and every other query on the site starved behind them. So: try the lock, and if it is
        // taken, ROLLBACK (which frees the backend), pause, and try again. Only holders pin a
        // backend. After the deadline the work proceeds under the in-process lock alone; the CAS in
        // saveDistributedJob guards the data either way.
        const deadline = Date.now() + PgStore.LOCK_WAIT_MS;
        for (let attempt = 1; ; attempt++) {
          await c.query("BEGIN");
          const r = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok", [key]);
          if (r.rows[0]?.ok) {
            locked = true;
            break;
          }
          clean = await c.query("ROLLBACK").then(() => true, () => false);
          if (!clean || Date.now() >= deadline) {
            console.warn(`[pgStore] lock ${key} not acquired after ${attempt} tries; continuing with in-process lock only`);
            break;
          }
          await new Promise((res) => setTimeout(res, 60 + Math.random() * 140));
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
      lanes: this.laneStatus(),
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
    // Same rule as mergeNodeCounters (store.ts), applied inside the upsert so it holds across
    // server instances: a counter never goes backwards, and reputation follows the writer that
    // has seen more checked jobs. Without this a stale read-modify-write erased other writers' increments.
    await this.q(
      `INSERT INTO brain_nodes (id, session_hash, status, data, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET session_hash = $2, status = $3, updated_at = now(),
         data = EXCLUDED.data
           || jsonb_build_object(${MONOTONIC_NODE_COUNTERS.map((k) => `'${k}', GREATEST(${numField("brain_nodes.data", k)}, ${numField("EXCLUDED.data", k)})`).join(", ")})
           || CASE WHEN brain_nodes.data ? 'reputation'
                    AND ${numField("brain_nodes.data", "verifiedJobs")} + ${numField("brain_nodes.data", "failedJobs")}
                      > ${numField("EXCLUDED.data", "verifiedJobs")} + ${numField("EXCLUDED.data", "failedJobs")}
                   THEN jsonb_build_object('reputation', brain_nodes.data->'reputation') ELSE '{}'::jsonb END`,
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
  async listLiveNodes() {
    const r = await this.q(`SELECT data FROM brain_nodes WHERE status IN ('idle', 'computing') AND updated_at > now() - interval '1 day'`);
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
  async saveJobs(js: StoredJob[]) {
    // Multi-row upsert, 100 rows per statement: creating a 64-unit job used to be 64 round trips
    // through the pooler while holding the create lock.
    for (let i = 0; i < js.length; i += 100) {
      const chunk = js.slice(i, i + 100);
      const values = chunk.map((_, k) => `($${k * 5 + 1}, $${k * 5 + 2}, $${k * 5 + 3}, $${k * 5 + 4}, $${k * 5 + 5})`).join(", ");
      await this.q(
        `INSERT INTO brain_jobs (id, assigned_to, status, submitted_at, data) VALUES ${values}
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data`,
        chunk.flatMap((j) => [j.id, j.assignedTo, j.status, j.submittedAt, JSON.stringify(j)]),
      );
    }
  }
  async markNodesComputing(ids: string[]) {
    if (ids.length === 0) return;
    await this.q(`UPDATE brain_nodes SET status = 'computing', data = data || '{"status":"computing"}'::jsonb, updated_at = now() WHERE id = ANY($1) AND status <> 'banned'`, [ids]);
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
    // Live estimates refresh every 5 minutes: the hourly window is a disk-bound scan of brain_jobs, and an
    // estimate a few minutes old is what the dashboard labels it as anyway.
    const slotMs = closed ? 86_400_000 : 300_000;
    const windowKey = `agg:${from}:${closed ? to : "live"}:${bucketMs}`;
    const key = `${windowKey}:${Math.floor(now / slotMs)}`;
    const memo = this.aggMemo.get(key);
    if (memo) return memo;
    const p = (async () => {
      const hit = await this.getDoc<{ rows: WorkAggregate[] }>("meta", key).catch(() => null);
      if (hit?.rows) return hit.rows;
      // Single flight across instances. Every serverless instance misses this slot at the same moment,
      // and a dozen copies of a 20 s scan over brain_jobs is what starves settlement. One instance holds
      // an advisory lock while it computes; the others serve the newest finished aggregate for the same
      // window (an estimate a minute old beats a stampede) or wait for the holder to publish.
      for (let attempt = 0; attempt < 2; attempt++) {
        const rows = await this.aggregateWorkUncached(from, closed ? to : now, bucketMs, windowKey, closed);
        if (rows) {
          await this.putDoc("meta", key, { rows, from, to: closed ? to : now, bucketMs }, { at: now, key: windowKey }).catch(() => undefined);
          return rows;
        }
        if (!closed) {
          const stale = await this.listDocs<{ rows: WorkAggregate[] }>("meta", { key: windowKey, limit: 1 }).catch(() => []);
          if (stale[0]?.rows) return stale[0].rows;
        }
        const published = await this.waitForDoc<{ rows: WorkAggregate[] }>("meta", key, closed ? 60_000 : 20_000);
        if (published?.rows) return published.rows;
      }
      throw new StoreUnavailableError(15, "work aggregate busy");
    })();
    this.aggMemo.set(key, p);
    p.catch(() => this.aggMemo.delete(key));
    // Memo lives for the slot; keep the map from growing.
    setTimeout(() => this.aggMemo.delete(key), slotMs).unref?.();
    if (this.aggMemo.size > 64) this.aggMemo.delete(this.aggMemo.keys().next().value as string);
    return p;
  }
  private aggMemo = new Map<string, Promise<WorkAggregate[]>>();

  /** Polls for a document another instance is about to publish. Resolves null when the wait runs out. */
  private async waitForDoc<T>(kind: DocKind, id: string, maxMs: number): Promise<T | null> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      const doc = await this.getDoc<T>(kind, id).catch(() => null);
      if (doc) return doc;
    }
    return null;
  }

  /** Returns null (without querying) when another instance holds the lock for this window. */
  private async aggregateWorkUncached(from: number, to: number, bucketMs: number, lockKey: string, closed: boolean): Promise<WorkAggregate[] | null> {
    await this.ready;
    const c = await this.breaker.run(() => this.viaLane((lane) => lane.pool.connect()));
    let failed: Error | undefined;
    try {
      await c.query("BEGIN");
      // Transaction-scoped so it works behind the transaction pooler and can never leak past COMMIT/ROLLBACK.
      const lock = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok", [lockKey]);
      if (!lock.rows[0]?.ok) {
        await c.query("ROLLBACK");
        return null;
      }
      // SET LOCAL survives the transaction pooler (the whole transaction is pinned to one backend).
      // A closed window is what settlement pays from, so it may take as long as the route allows; a live
      // estimate gives up sooner and serves the previous aggregate instead.
      const serverTimeoutS = closed ? 120 : 30;
      await c.query(`SET LOCAL statement_timeout = '${serverTimeoutS}s'`);
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
        query_timeout: serverTimeoutS * 1000 + 2_000,
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
  async pruneJobs(olderThan: number, opts: { batch?: number; deadlineMs?: number } = {}) {
    // Small batches, each its own short statement: a single DELETE of a day of rows would hold
    // locks and WAL for minutes and trip the pool's statement timeout. Oldest first via the
    // submitted_at index; the ctid subquery keeps each batch to one index range scan.
    const batch = Math.max(100, Math.min(opts.batch ?? 2_000, 20_000));
    const deadline = Date.now() + (opts.deadlineMs ?? 60_000);
    // On a disk-bound database one batch can take tens of seconds. Each runs in its own transaction
    // so SET LOCAL statement_timeout reaches the backend through the transaction pooler (the pool's
    // connection-level setting does not), and the client waits a little longer than the server so a
    // cancelled statement is reported here rather than left running. One instance prunes at a time.
    const BATCH_TIMEOUT_S = 90;
    await this.ready;
    const c = await this.breaker.run(() => this.viaLane((lane) => lane.pool.connect()));
    let failed: Error | undefined;
    let deleted = 0;
    try {
      for (;;) {
        await c.query("BEGIN");
        const lock = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('brain:prune')) AS ok");
        if (!lock.rows[0]?.ok) {
          await c.query("ROLLBACK");
          return { deleted, done: false };
        }
        await c.query(`SET LOCAL statement_timeout = '${BATCH_TIMEOUT_S}s'`);
        const cfg: QueryConfig & { query_timeout: number } = {
          text: `/* pruneJobs */ DELETE FROM brain_jobs WHERE ctid = ANY(ARRAY(
                   SELECT ctid FROM brain_jobs
                    WHERE submitted_at < $1 AND coalesce(data->>'source', '') NOT LIKE 'native%'
                    ORDER BY submitted_at LIMIT $2))`,
          values: [olderThan, batch],
          query_timeout: BATCH_TIMEOUT_S * 1000 + 2_000,
        };
        const r = await c.query(cfg);
        await c.query("COMMIT");
        deleted += r.rowCount ?? 0;
        if ((r.rowCount ?? 0) < batch) return { deleted, done: true };
        if (Date.now() >= deadline) return { deleted, done: false };
      }
    } catch (e) {
      failed = e instanceof Error ? e : new Error(String(e));
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release(failed);
    }
  }
  async getEpoch(id: string) {
    const r = await this.q(`SELECT data FROM brain_reward_epochs WHERE id = $1`, [id]);
    return (r.rows[0]?.data as RewardEpoch) ?? null;
  }
  async saveSettlement(epoch: RewardEpoch, allocations: RewardAllocation[]) {
    await this.ready;
    const c = await this.breaker.run(() => this.viaLane((lane) => lane.pool.connect()));
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
  async listPaidClaims(limit: number) {
    const r = await this.q(`SELECT data FROM brain_reward_claims WHERE status IN ('sent', 'confirmed') ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => x.data as RewardClaim);
  }
  async paidClaimTotals() {
    const r = await this.q<{ lamports: string; count: string; wallets: string; first_at: string | null; last_at: string | null }>(
      `SELECT COALESCE(SUM(lamports), 0) AS lamports, COUNT(*) AS count, COUNT(DISTINCT wallet) AS wallets, MIN(created_at) AS first_at, MAX(created_at) AS last_at
       FROM brain_reward_claims WHERE status IN ('sent', 'confirmed')`,
    );
    const x = r.rows[0];
    return { lamports: Number(x?.lamports ?? 0), count: Number(x?.count ?? 0), wallets: Number(x?.wallets ?? 0), firstAt: x?.first_at ? Number(x.first_at) : null, lastAt: x?.last_at ? Number(x.last_at) : null };
  }
  async saveDistributedJob(j: DistributedJob) {
    // Compare-and-swap on the revision held in the document: the update only lands if the stored
    // row still carries the rev this copy was read at (rows written before revs existed count as 0).
    // On success the caller's object takes the new rev so its next save in the same flow is valid.
    const expected = j.rev ?? 0;
    const next = expected + 1;
    const r = await this.q(
      `INSERT INTO brain_distributed_jobs (id, status, created_at, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET status = $2, data = $4
       WHERE COALESCE((brain_distributed_jobs.data->>'rev')::int, 0) = $5`,
      [j.id, j.status, j.createdAt, JSON.stringify({ ...j, rev: next }), expected],
    );
    if (r.rowCount === 0) throw new StoreConflictError("distributed job", j.id);
    j.rev = next;
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
