/**
 * Prices. Every price comes from operator configuration (env) or a measured upstream price.
 * Unset ⇒ null ⇒ rendered as UNKNOWN / unpriced. Nothing here invents a number.
 *
 * Env (all optional, USD):
 *   BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS  list price customers accrue per 1,000 verified compute units
 *   BRAIN_PRICE_USD_PER_1M_TOKENS         list price customers accrue per 1M chat tokens routed by BRAIN
 *   BRAIN_FALLBACK_PRICE_USD_PER_1M       what the CLOUD_GPU upstream charges us per 1M tokens
 *   BRAIN_EXTERNAL_PRICE_USD_PER_1M       what the EXTERNAL_MODEL upstream charges us per 1M tokens
 */

const num = (v: string | undefined): number | null => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n >= 0 ? n : null;
};

export function computeUnitListPriceUsd(): number | null {
  return num(process.env.BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS);
}

export function tokenListPricePer1MUsd(): number | null {
  return num(process.env.BRAIN_PRICE_USD_PER_1M_TOKENS);
}

export function upstreamPricePer1MUsd(providerId: "cloud-fallback" | "external"): number | null {
  return num(providerId === "cloud-fallback" ? process.env.BRAIN_FALLBACK_PRICE_USD_PER_1M : process.env.BRAIN_EXTERNAL_PRICE_USD_PER_1M);
}

export function priceForComputeUnits(units: number): number | null {
  const p = computeUnitListPriceUsd();
  return p == null ? null : (units / 1000) * p;
}

export function priceForTokens(tokens: number, per1M: number | null): number | null {
  return per1M == null ? null : (tokens / 1_000_000) * per1M;
}
