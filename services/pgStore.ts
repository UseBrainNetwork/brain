import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import type { DistributedJob, RewardAllocation, RewardClaim, RewardEpoch } from "@/domain/types";
import { KeyedMutex, type DocKind, type DocQuery, type NetworkStore, type StoredChallenge, type StoredJob, type StoredNode } from "./store";

/** Postgres implementation of NetworkStore. Schema: db/schema.sql. */
export class PgStore implements NetworkStore {
  private pool: Pool;
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
    } catch {
      /* not a URL-shaped string; pass through */
    }
    this.pool = new Pool({ connectionString: cs, max: 5, ssl: local ? undefined : { rejectUnauthorized: false } });
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
      await this.pool.query(sql);
      // Advisory locks held for more than a minute belong to a frozen or dead instance. Clear them.
      await this.pool.query(
        `SELECT pg_terminate_backend(a.pid) FROM pg_locks l JOIN pg_stat_activity a USING (pid)
         WHERE l.locktype = 'advisory' AND a.pid <> pg_backend_pid() AND a.state_change < now() - interval '60 seconds'`,
      );
    } catch (e) {
      console.error("[pgStore] schema migration failed:", (e as Error).message);
    }
  }

  /** Pool query gated on the schema being applied. */
  private async q<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) {
    await this.ready;
    return this.pool.query<T>(text, params);
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
      const c = await this.pool.connect();
      let locked = false;
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL lock_timeout = '10s'");
        try {
          await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
          locked = true;
        } catch (e) {
          console.warn(`[pgStore] lock ${key} not acquired (${(e as Error).message}); continuing with in-process lock only`);
          await c.query("ROLLBACK").catch(() => undefined);
        }
        return await fn();
      } finally {
        if (locked) await c.query("COMMIT").catch(() => c.query("ROLLBACK").catch(() => undefined));
        c.release();
      }
    });
  }

  /** Which backend is serving, for operational views. */
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
  async getNodeBySession(sessionHash: string) {
    const r = await this.q(`SELECT data FROM brain_nodes WHERE session_hash = $1`, [sessionHash]);
    return (r.rows[0]?.data as StoredNode) ?? null;
  }
  async listNodes() {
    const r = await this.q(`SELECT data FROM brain_nodes WHERE updated_at > now() - interval '1 day'`);
    return r.rows.map((x) => x.data as StoredNode);
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
    const c = await this.pool.connect();
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
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
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
