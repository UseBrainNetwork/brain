import type { PoolSources } from "@/domain/types";
import { defaultRevenueSplit } from "@/rewards/config";
import type { PaymentIntent } from "./payments";
import { INTENT_TTL_MS } from "./payments";
import { solUsd, type SolQuote } from "./solPrice";
import { getStore } from "./store";

/**
 * The pool an epoch distributes has two sources, and both are money that exists:
 *
 *  1. The fixed pool, BRAIN_EPOCH_POOL_SOL, set by the operator and funded from creator fees.
 *  2. The contributors' share of plan sales: every Pro/Code/Max purchase confirmed on chain while
 *     the epoch was open, times `inferenceRevenue.contributors` (rewards/config.ts, 0.6 today).
 *     SOL purchases count at their lamports. USDC purchases are converted at the SOL/USD quote in
 *     force at settlement, which the epoch records. Free credits are not sales and add nothing.
 *
 * So sales grow the pool, verified units split it, and a node that served a paying customer is
 * paid out of what that customer paid, in the same epoch, through the same formula as everyone
 * else. The share is a configured rule, not an estimate; the sum is read from the payment records
 * each purchase wrote when its signature was verified. BRAIN_POOL_SALES_SHARE overrides the share
 * (0 turns it off).
 */

export function salesShare(): number {
  const v = Number(process.env.BRAIN_POOL_SALES_SHARE);
  if (process.env.BRAIN_POOL_SALES_SHARE != null && process.env.BRAIN_POOL_SALES_SHARE !== "" && Number.isFinite(v) && v >= 0 && v <= 1) return v;
  return defaultRevenueSplit.inferenceRevenue.contributors;
}

export class PoolSourcesError extends Error {
  constructor(public readonly code: "sol_price_unavailable") {
    super(code);
  }
}

/** Confirmed purchases whose confirmation fell inside [from, to). */
export async function confirmedSales(from: number, to: number): Promise<PaymentIntent[]> {
  // Payment documents are indexed by creation time; an intent lives INTENT_TTL_MS (plus a grace
  // period in confirmIntent), so everything confirmed in the window was created after from − that.
  const docs = await getStore().listDocs<PaymentIntent>("payment", { from: from - INTENT_TTL_MS - 10 * 60_000, to, limit: 5000 });
  return docs.filter((p) => p && p.status === "confirmed" && typeof p.confirmedAt === "number" && p.confirmedAt >= from && p.confirmedAt < to && p.plan != null);
}

/** Pure: the sales side of the pool from a list of purchases. Exported for tests. */
export function salesPool(sales: PaymentIntent[], share: number, quote: SolQuote | null): Omit<PoolSources, "fixedLamports"> {
  let lamports = 0;
  let usd = 0;
  let needQuote = false;
  for (const p of sales) {
    usd += p.amountUsd;
    if (p.currency === "SOL") lamports += p.baseUnits;
    else needQuote = true;
  }
  if (needQuote && !quote) throw new PoolSourcesError("sol_price_unavailable");
  if (needQuote && quote) {
    const usdcUsd = sales.filter((p) => p.currency !== "SOL").reduce((s, p) => s + p.amountUsd, 0);
    lamports += Math.floor((usdcUsd / quote.usd) * 1_000_000_000);
  }
  return {
    salesLamports: Math.floor(lamports * share),
    salesUsd: Number(usd.toFixed(2)),
    purchases: sales.length,
    share,
    solUsd: needQuote && quote ? quote.usd : null,
  };
}

/** The pool for one epoch: fixed plus the contributors' share of what was sold while it was open. */
export async function poolSources(fixedLamports: number, from: number, to: number, now = Date.now()): Promise<PoolSources> {
  const share = salesShare();
  if (share <= 0) return { fixedLamports, salesLamports: 0, salesUsd: 0, purchases: 0, share, solUsd: null };
  const sales = await confirmedSales(from, to);
  if (sales.length === 0) return { fixedLamports, salesLamports: 0, salesUsd: 0, purchases: 0, share, solUsd: null };
  const quote = sales.some((p) => p.currency !== "SOL") ? await solUsd(now) : null;
  return { fixedLamports, ...salesPool(sales, share, quote) };
}
