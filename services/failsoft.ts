/**
 * Fail soft when the database is unreachable.
 *
 * Without this, every request that touches Postgres waits the full connect timeout (8 s, several
 * times over when queries run in parallel) and then returns 500 "internal_error". During a database
 * outage that means a 30 s hang for every visitor and every browser node. With it:
 *
 *   Breaker        after two consecutive connectivity failures the store refuses queries instantly
 *                  for 15 s, then lets exactly one probe through. Instances recover on their own.
 *   StoreUnavailableError  a typed error routes map to 503 + Retry-After instead of 500.
 *   lastKnownGood  public read routes keep the last successful body in the instance and return it
 *                  with `stale: true` and the time it was captured. Never fabricated: if there is no
 *                  previous body the route still fails, now in milliseconds instead of seconds.
 */

/** A compare-and-swap save lost: the document changed since it was read. Re-read and apply again. */
export class StoreConflictError extends Error {
  readonly code = "store_conflict";
  constructor(kind: string, id: string) {
    super(`${kind} ${id} changed since it was read`);
    this.name = "StoreConflictError";
  }
}

/** Structural check for the same reason as isStoreUnavailable: the class can exist twice at runtime. */
export function isStoreConflict(e: unknown): e is StoreConflictError {
  return typeof e === "object" && e != null && (e as { code?: unknown }).code === "store_conflict";
}

/** Re-run `fn` while it fails with a StoreConflictError; the function must be safe to repeat from its first read. */
export async function retryOnConflict<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isStoreConflict(e) || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 60 * (i + 1)));
    }
  }
}

export class StoreUnavailableError extends Error {
  readonly code = "database_unavailable";
  readonly status = 503;
  constructor(public readonly retryAfterSec: number, cause?: string) {
    super(cause ? `database unavailable: ${cause}` : "database unavailable");
    this.name = "StoreUnavailableError";
  }
}

/**
 * Structural check, not `instanceof`: the bundler can place this module in more than one chunk
 * (route layer and store layer), and then two StoreUnavailableError classes exist at runtime.
 */
export function isStoreUnavailable(e: unknown): e is StoreUnavailableError {
  return typeof e === "object" && e != null && (e as { code?: unknown }).code === "database_unavailable" && (e as { status?: unknown }).status === 503;
}

/**
 * Transient database trouble a page should degrade on rather than crash: connectivity loss, pooler
 * rejection, or a statement/query timeout (SQLSTATE 57014, or the pg driver's own read timeout).
 * SQL errors that indicate a bug (bad column, constraint) are not transient and are not matched.
 */
export function isTransientDbError(e: unknown): boolean {
  if (isConnectivityError(e)) return true;
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  if (String(err.code ?? "") === "57014") return true;
  return /statement timeout|Query read timeout|canceling statement/i.test(String(err.message ?? ""));
}

/** Connection-level failures (not SQL errors): the database or pooler is not answering. */
export function isConnectivityError(e: unknown): boolean {
  if (isStoreUnavailable(e)) return true;
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  const code = String(err.code ?? "");
  if (/^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE)$/.test(code)) return true;
  // SQLSTATE class 08 = connection exception; 57P01..03 = admin shutdown / crash / cannot connect now; 53300 = too many connections.
  if (/^08|^57P0[123]$|^53300$/.test(code)) return true;
  if (isPoolerRejection(e)) return true;
  const msg = String(err.message ?? "");
  return /timeout exceeded when trying to connect|Connection terminated|terminating connection|the database system is (starting up|shutting down)|server closed the connection|Client has encountered a connection error/i.test(msg);
}

/**
 * The connection pooler (Supavisor) refused a fresh connection for a reason that is its own, not ours:
 * its client cap, or a tenant pool whose cached database credentials went bad ("Authentication
 * credentials are invalid. Please reconnect with fresh credentials to restore pool functionality",
 * SQLSTATE 28P01 with that exact wording). Both clear on their own and a new connection usually lands
 * on a healthy pooler node, so callers retry once before counting it as an outage. A genuinely wrong
 * password is 28P01 without the pooler's sentence and is not matched here.
 */
export function isPoolerRejection(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  const msg = String(err.message ?? "");
  // "max client connections reached" (transaction mode), "MaxClientsInSessionMode … max clients reached" (session mode).
  if (/max client connections reached|max clients reached|MaxClientsInSessionMode|EMAXCONN/i.test(msg)) return true;
  return String(err.code ?? "") === "28P01" && /restore pool functionality|reconnect with fresh credentials/i.test(msg);
}

export interface BreakerOptions {
  /** Consecutive connectivity failures before the breaker opens. */
  threshold?: number;
  /** How long the breaker stays open before allowing one probe. */
  openMs?: number;
  now?: () => number;
}

export class Breaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private readonly threshold: number;
  private readonly openMs: number;
  private readonly now: () => number;
  constructor(o: BreakerOptions = {}) {
    this.threshold = o.threshold ?? 2;
    this.openMs = o.openMs ?? 15_000;
    this.now = o.now ?? Date.now;
  }

  get open() {
    return this.openedAt > 0;
  }

  /** Call before a query. Throws immediately while open; lets one probe through after `openMs`. */
  check() {
    if (!this.openedAt) return;
    const age = this.now() - this.openedAt;
    if (age >= this.openMs && !this.probing) {
      this.probing = true; // half-open: this caller is the probe
      return;
    }
    throw new StoreUnavailableError(Math.max(1, Math.ceil((this.openMs - age) / 1000)));
  }

  success() {
    this.failures = 0;
    this.openedAt = 0;
    this.probing = false;
  }

  /** Returns true if the error was a connectivity failure (and so counted). */
  failure(e: unknown) {
    if (!isConnectivityError(e)) return false;
    this.failures++;
    this.probing = false;
    if (this.openedAt) this.openedAt = this.now(); // probe failed: stay open another window
    else if (this.failures >= this.threshold) this.openedAt = this.now();
    return true;
  }

  /** Wrap one operation. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.check();
    try {
      const v = await fn();
      this.success();
      return v;
    } catch (e) {
      if (this.failure(e)) throw new StoreUnavailableError(Math.ceil(this.openMs / 1000), (e as Error).message);
      throw e;
    }
  }
}

/* ------------------------------------------------------------ last known good */

export interface Snapshot<T> {
  body: T;
  /** When the body was built from the database. */
  asOf: number;
  /** True when the database could not be read and this is an older body. */
  stale: boolean;
}

interface Slot<T> {
  body: T | null;
  at: number;
  inflight: Promise<T> | null;
}

const g = globalThis as typeof globalThis & { __brainLkg?: Map<string, Slot<unknown>> };
const slots = (g.__brainLkg ??= new Map());

/**
 * Per-instance cache that survives a failed rebuild. Fresh within `ttlMs`; after that rebuilds, and
 * if the rebuild throws a connectivity error returns the previous body flagged `stale`. Any other
 * error propagates. If there is no previous body the error propagates too.
 */
export async function lastKnownGood<T>(key: string, ttlMs: number, build: () => Promise<T>): Promise<Snapshot<T>> {
  const slot = (slots.get(key) as Slot<T> | undefined) ?? (slots.set(key, { body: null, at: 0, inflight: null }), slots.get(key) as Slot<T>);
  const now = Date.now();
  if (slot.body != null && now - slot.at < ttlMs) return { body: slot.body, asOf: slot.at, stale: false };
  slot.inflight ??= build()
    .then((b) => {
      slot.body = b;
      slot.at = Date.now();
      return b;
    })
    .finally(() => (slot.inflight = null));
  try {
    const body = await slot.inflight;
    return { body, asOf: slot.at, stale: false };
  } catch (e) {
    if (slot.body != null && isConnectivityError(e)) return { body: slot.body, asOf: slot.at, stale: true };
    throw e;
  }
}

/** Test hook. */
export function resetLastKnownGood() {
  slots.clear();
}
