import type { ExecutionTarget } from "@/domain/economy";

/**
 * Gateway policy: what the router does when an attempt fails. Portkey/Helicone-style retries,
 * fallback and provider cooldown, in-house, with every attempt written to the order so the
 * customer can see what happened rather than trusting that something did.
 *
 *   retries   — extra tries on the SAME provider when the failure looks transient (0..2, default 1)
 *   fallback  — move on to the next ranked eligible provider when one is exhausted (default true)
 *   timeoutMs — total wall budget for attempts; no new attempt starts past it (default: the
 *               step's maxLatency when set, else 60 s)
 *
 * Retries only happen before the first byte reaches the customer. A stream that has started
 * cannot be replayed, so a mid-stream failure is reported as such, never silently re-run.
 */
export interface GatewayPolicy {
  retries: number;
  fallback: boolean;
  timeoutMs: number | null;
}

export const DEFAULT_POLICY: GatewayPolicy = { retries: 1, fallback: true, timeoutMs: null };
export const MAX_RETRIES = 2;
export const DEFAULT_BUDGET_MS = 60_000;

/** One execution attempt as recorded on the order. `retry` is 0 for the first try on that provider. */
export interface AttemptRecord {
  provider: string;
  target: ExecutionTarget;
  retry: number;
  ok: boolean;
  error?: string;
  ms: number;
  at: number;
}

/**
 * Parses policy from a request body. Accepts a `brain` object (`{ retries, fallback, timeout_ms }`)
 * or the same keys at the top level. Anything missing takes the default; anything malformed is ignored.
 */
export function parsePolicy(raw: Record<string, unknown> | null | undefined, base: GatewayPolicy = DEFAULT_POLICY): GatewayPolicy {
  const src = raw && typeof raw.brain === "object" && raw.brain ? { ...raw, ...(raw.brain as Record<string, unknown>) } : (raw ?? {});
  const retries = Number(src.retries);
  const timeout = Number(src.timeout_ms ?? src.timeoutMs);
  return {
    retries: Number.isInteger(retries) ? Math.min(MAX_RETRIES, Math.max(0, retries)) : base.retries,
    fallback: typeof src.fallback === "boolean" ? src.fallback : base.fallback,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(600_000, Math.max(1_000, Math.round(timeout))) : base.timeoutMs,
  };
}

/**
 * Whether a failed attempt is worth repeating. Transient: timeouts, unreachable upstreams, 408/409/
 * 425/429/5xx, nodes that never started or lost the job. Not transient: anything that says the
 * request itself is the problem — 4xx from upstream, unsupported kind, privacy or size rules,
 * a model nobody serves. Unknown free-text reasons are treated as transient once; the retry cap
 * bounds the cost of being wrong.
 */
export function isRetryable(error: string | undefined): boolean {
  if (!error) return true;
  const e = error.toLowerCase();
  const m = /^upstream (\d{3})$/.exec(e);
  if (m) {
    const s = Number(m[1]);
    return s >= 500 || s === 408 || s === 409 || s === 425 || s === 429;
  }
  if (/unsupported|privacy|payload_too_large|too large|invalid|not_allowlisted|model_not_found|no node serves|no capable node|unauthenticated|banned|cancelled/.test(e)) return false;
  return true;
}

/** Exponential backoff with jitter: 200, 400, 800 ms (+0..100), capped. */
export const backoffMs = (retry: number, rand = Math.random) => Math.min(1_500, 200 * 2 ** retry + Math.floor(rand() * 100));

/* ------------------------------------------------------------ provider cooldown */

const COOLDOWN_AFTER = 3;
const COOLDOWN_MS = 30_000;
const WINDOW_MS = 60_000;

interface Health {
  consecutive: number;
  lastFailAt: number;
  coolingUntil: number;
}

const g = globalThis as typeof globalThis & { __brainProviderHealth?: Map<string, Health> };
const health = () => (g.__brainProviderHealth ??= new Map());

/**
 * Records the outcome of an attempt. Three consecutive transient failures inside a minute put the
 * provider in a 30 s cooldown: it is ranked last, not removed, so a lone provider is still tried.
 */
export function noteAttempt(providerId: string, ok: boolean, error?: string, now = Date.now()) {
  const h = health().get(providerId) ?? { consecutive: 0, lastFailAt: 0, coolingUntil: 0 };
  if (ok) {
    h.consecutive = 0;
    h.coolingUntil = 0;
  } else if (isRetryable(error)) {
    h.consecutive = now - h.lastFailAt > WINDOW_MS ? 1 : h.consecutive + 1;
    h.lastFailAt = now;
    if (h.consecutive >= COOLDOWN_AFTER) h.coolingUntil = now + COOLDOWN_MS;
  }
  health().set(providerId, h);
}

export const isCooling = (providerId: string, now = Date.now()) => (health().get(providerId)?.coolingUntil ?? 0) > now;

/** Stable: healthy providers keep their rank; cooling ones move to the back in their original order. */
export function orderByHealth<T extends { provider: string }>(ranked: T[], now = Date.now()): T[] {
  const hot = ranked.filter((r) => !isCooling(r.provider, now));
  const cold = ranked.filter((r) => isCooling(r.provider, now));
  return [...hot, ...cold];
}

export function providerHealthSnapshot(now = Date.now()) {
  return [...health().entries()].map(([provider, h]) => ({ provider, consecutiveFailures: h.consecutive, coolingForMs: Math.max(0, h.coolingUntil - now) }));
}

/** Tests only. */
export function resetProviderHealth() {
  health().clear();
}
