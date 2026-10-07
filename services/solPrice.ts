/**
 * SOL/USD from real sources, for pricing plan purchases paid in SOL. Coinbase's spot price and
 * Jupiter's on-chain price are both public and keyless. When both answer they must agree within
 * 2 %, and the lower is used (the buyer is never over-charged by a stale feed). When neither
 * answers there is no price and SOL payment is unavailable: the site never invents a rate (USDC
 * still works, 1:1). Every quote records where it came from so the payment can say so.
 */
export interface SolQuote {
  usd: number;
  source: "coinbase" | "jupiter" | "coinbase+jupiter";
  at: number;
}

const TTL_MS = 60_000;
const WSOL = "So11111111111111111111111111111111111111112";
let cache: { at: number; quote: SolQuote | null } | null = null;

async function fromCoinbase(): Promise<number | null> {
  const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", { signal: AbortSignal.timeout(5000), cache: "no-store" });
  if (!r.ok) return null;
  const j = (await r.json()) as { data?: { amount?: string } };
  const usd = Number(j.data?.amount);
  return usd > 0 ? usd : null;
}

async function fromJupiter(): Promise<number | null> {
  const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL}`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
  if (!r.ok) return null;
  const j = (await r.json()) as Record<string, { usdPrice?: number }>;
  const usd = j[WSOL]?.usdPrice;
  return usd && usd > 0 ? usd : null;
}

/** Combine two independent reads. Exported for tests. */
export function combineQuotes(coinbase: number | null, jupiter: number | null, at: number): SolQuote | null {
  if (coinbase && jupiter) {
    if (Math.abs(coinbase - jupiter) / Math.max(coinbase, jupiter) > 0.02) return null;
    return { usd: Math.min(coinbase, jupiter), source: "coinbase+jupiter", at };
  }
  if (coinbase) return { usd: coinbase, source: "coinbase", at };
  if (jupiter) return { usd: jupiter, source: "jupiter", at };
  return null;
}

/** Current SOL/USD, cached one minute. null when no real source answered or the sources disagree. */
export async function solUsd(now = Date.now()): Promise<SolQuote | null> {
  if (cache && now - cache.at < TTL_MS && cache.quote) return cache.quote;
  const [cb, jp] = await Promise.all([fromCoinbase().catch(() => null), fromJupiter().catch(() => null)]);
  const quote = combineQuotes(cb, jp, now);
  cache = { at: now, quote };
  return quote;
}

/** Test hook. */
export function _resetSolPriceCache() {
  cache = null;
}
