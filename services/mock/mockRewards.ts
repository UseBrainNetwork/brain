import type { RewardAllocation, RewardEpoch } from "@/domain/types";
import { mulberry32 } from "@/network/workloads";
import { sha256 } from "@/services/security";
import { demoPoolLamports, epochAt, epochLengthMs } from "@/services/settlement";

/**
 * DEMO epoch history for a wallet that has never settled. Deterministic per address so the
 * page is stable across reloads. Every row is provenance "simulated" and is never claimable.
 */
export function demoRewardHistory(wallet: string, count = 10, now = Date.now()): (RewardEpoch & { allocation: RewardAllocation })[] {
  const rand = mulberry32(parseInt(sha256(`demo-rewards:${wallet}`).slice(0, 8), 16));
  const r = () => rand() / 2 ** 32;
  const len = epochLengthMs();
  const pool = demoPoolLamports(len);
  const baseShare = 0.00008 + r() * 0.00022;
  const out: (RewardEpoch & { allocation: RewardAllocation })[] = [];
  for (let i = 1; i <= count; i++) {
    const e = epochAt(now - i * len);
    const online = r() > 0.15;
    const availability = online ? 0.45 + r() * 0.5 : 0;
    const multiplier = 1.1 + r() * 0.9;
    const quality = online ? 0.86 + r() * 0.12 : 0;
    const share = online ? baseShare * availability * multiplier * (0.8 + r() * 0.4) : 0;
    const verifiedCompute = online ? Math.round(180_000 * availability * (0.7 + r() * 0.6)) : 0;
    const allocation: RewardAllocation = {
      epochId: e.id,
      wallet,
      lamports: Math.floor(pool * share),
      verifiedCompute,
      jobsAssigned: online ? Math.round(verifiedCompute / 9.6) : 0,
      jobsCompleted: online ? Math.round((verifiedCompute / 9.6) * (0.97 + r() * 0.03)) : 0,
      availability,
      multiplier,
      quality,
      computeShare: share,
      capped: false,
      provenance: "simulated",
    };
    out.push({
      id: e.id,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      poolLamports: pool,
      distributedLamports: Math.floor(pool * 0.98),
      participants: 12_842,
      totalVerifiedCompute: 2_310_000_000,
      settledAt: e.endsAt + 4 * 60_000,
      provenance: "simulated",
      allocation,
    });
  }
  return out;
}
