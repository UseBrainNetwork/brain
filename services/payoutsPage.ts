import "server-only";
import type { RewardClaim, RewardEpoch } from "@/domain/types";
import { solUsd, type SolQuote } from "./solPrice";
import { getStore, type PaidClaimTotals } from "./store";

/**
 * Everything the public payouts page shows. All of it is read from records of things that already
 * happened: claims that were sent on chain (each with its transaction signature) and epochs that
 * settled. Nothing here is projected or estimated except the USD figure, which is the current
 * market quote applied to SOL already paid, and is labelled as such.
 */
export interface PayoutsData {
  totals: PaidClaimTotals;
  claims: RewardClaim[];
  epochs: RewardEpoch[];
  /** SOL allocated across live settled epochs (claimable or already claimed). */
  allocatedLamports: number;
  liveEpochs: number;
  /** Paid SOL per UTC day, oldest first, covering the last `days` days. */
  daily: { day: string; lamports: number; payouts: number }[];
  /** Current SOL/USD market quote, for the "≈ USD" line only. Null when sources disagree or are down. */
  quote: SolQuote | null;
  at: number;
}

export function bucketByDay(claims: RewardClaim[], days: number, now = Date.now()) {
  const start = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - (days - 1) * 86_400_000;
  const out = Array.from({ length: days }, (_, i) => ({ day: new Date(start + i * 86_400_000).toISOString().slice(0, 10), lamports: 0, payouts: 0 }));
  for (const c of claims) {
    const i = Math.floor((c.createdAt - start) / 86_400_000);
    if (i >= 0 && i < days) {
      out[i].lamports += c.lamports;
      out[i].payouts += 1;
    }
  }
  return out;
}

export async function payoutsData(opts: { claims?: number; epochs?: number; days?: number } = {}): Promise<PayoutsData> {
  const store = getStore();
  const days = opts.days ?? 30;
  const [totals, claims, allEpochs, allClaimsForChart, quote] = await Promise.all([
    store.paidClaimTotals(),
    store.listPaidClaims(opts.claims ?? 100),
    store.listEpochs(5000),
    store.listPaidClaims(5000),
    solUsd().catch(() => null),
  ]);
  const live = allEpochs.filter((e) => e.provenance === "live");
  return {
    totals,
    claims,
    epochs: live.slice(0, opts.epochs ?? 168),
    allocatedLamports: live.reduce((s, e) => s + e.distributedLamports, 0),
    liveEpochs: live.length,
    daily: bucketByDay(allClaimsForChart, days),
    quote,
    at: Date.now(),
  };
}
