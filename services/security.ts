import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { networkConfig } from "@/lib/config";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const token = (bytes = 32) => randomBytes(bytes).toString("hex");
export const secureU32 = () => randomBytes(4).readUInt32LE(0);
export const secureInt = (maxExclusive: number) => randomInt(0, maxExclusive);

/** Anonymous public node id: 4 hex chars, random, never derived from IP or wallet. */
export const publicNodeId = () => randomBytes(2).toString("hex").toUpperCase();

/** Pick `count` distinct indices in [0, n) with a CSPRNG. */
export function sampleIndices(n: number, count: number): number[] {
  const set = new Set<number>();
  const c = Math.min(count, n);
  while (set.size < c) set.add(secureInt(n));
  return [...set];
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] || req.headers.get("x-real-ip") || "local").trim();
}

/** IPs are stored only as salted hashes, for rate limiting and ban evasion checks. */
export const ipHash = (req: Request) => sha256(`brain-ip:${clientIp(req)}`).slice(0, 24);

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/* ------------------------------------------------------------- rate limiting */

interface Bucket {
  count: number;
  resetAt: number;
}
const g = globalThis as typeof globalThis & { __brainRl?: Map<string, Bucket> };
const buckets = (g.__brainRl ??= new Map());

/** Fixed-window limiter. In-process; move to Redis for multi-instance deployments. */
export function rateLimit(key: string, limit: number, windowMs = networkConfig.rateLimit.windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  }
  return { ok: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.resetAt };
}

export function json(data: unknown, init?: number | ResponseInit) {
  const resInit = typeof init === "number" ? { status: init } : init;
  return Response.json(data, { ...resInit, headers: { "Cache-Control": "no-store", ...(resInit?.headers ?? {}) } });
}

export function tooMany() {
  return json({ error: "rate_limited" }, 429);
}

/* ------------------------------------------------------------ server secret */

const gs = globalThis as typeof globalThis & { __brainSecret?: Buffer };

/** HMAC key for stateless tokens. Set BRAIN_SERVER_SECRET whenever more than one instance can serve requests. */
export function serverSecret(): Buffer {
  const env = process.env.BRAIN_SERVER_SECRET;
  if (env) return Buffer.from(env, "utf8");
  return (gs.__brainSecret ??= randomBytes(32));
}

export const hmac = (data: string) => createHmac("sha256", serverSecret()).update(data).digest("hex").slice(0, 32);

export function hmacEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
