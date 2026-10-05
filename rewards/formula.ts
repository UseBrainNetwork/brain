import { defaultRewardConfig, type RewardConfig } from "./config";

/**
 * Reward weighting.
 *
 *   computeShare_i = verifiedCompute_i / Σ verifiedCompute
 *   tokenShare_i   = min(holdings_i / supply, tokenShareCap)
 *
 *   normCompute_i  = computeShare_i · N            (1.0 = average node)
 *   normToken_i    = (tokenShare_i / mean(tokenShare))^γ
 *
 *   effToken_i     = max(normToken_i, λ · normCompute_i)
 *   baseScore_i    = sqrt(normCompute_i · effToken_i)            ← geometric mean
 *   multiplier_i   = min(baseScore_i / (√λ · normCompute_i), maxMultiplier)
 *   quality_i      = reliability^a · completionRate^b · availability^c
 *   score_i        = √λ · normCompute_i · multiplier_i · quality_i
 *
 *   rewardWeight_i = score_i / Σ score, then water-filled under maxNodeShareOfPool.
 *
 * Properties (tested): zero verified compute ⇒ zero reward regardless of holdings;
 * a non-holder's score is linear in compute (Sybil-neutral); the multiplier is bounded,
 * so every node's reward is bounded by a constant times its own verified compute.
 */

export interface ContributorInput {
  id: string;
  verifiedCompute: number;
  tokenAmount: number;
  /** 0..1, from the reputation system. */
  reliability: number;
  jobsAssigned: number;
  jobsCompleted: number;
  /** 0..1, observed heartbeats / expected heartbeats. */
  availability: number;
  /** 0..1, verified results / checked results. */
  verificationPassRate: number;
  banned?: boolean;
}

export type IneligibleReason = "banned" | "no-verified-compute" | "verification-below-threshold";

export interface ContributorReward {
  id: string;
  eligible: boolean;
  reason?: IneligibleReason;
  computeShare: number;
  tokenShare: number;
  normCompute: number;
  normToken: number;
  baseScore: number;
  multiplier: number;
  quality: number;
  score: number;
  rewardWeight: number;
  payout: number;
  capped: boolean;
}

export interface EpochAllocation {
  poolUsd: number;
  distributedUsd: number;
  /** Left over when caps bind (e.g. very few participants). Returns to the pool. */
  undistributedUsd: number;
  rewards: ContributorReward[];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function eligibility(c: ContributorInput, cfg: RewardConfig): IneligibleReason | undefined {
  if (c.banned) return "banned";
  if (!(c.verifiedCompute > 0) || c.verifiedCompute <= cfg.minVerifiedCompute) return "no-verified-compute";
  if (c.verificationPassRate < cfg.minVerificationPassRate) return "verification-below-threshold";
  return undefined;
}

export function qualityFactor(c: ContributorInput, cfg: RewardConfig): number {
  const completion = c.jobsAssigned > 0 ? clamp01(c.jobsCompleted / c.jobsAssigned) : 0;
  const w = cfg.qualityWeights;
  return (
    Math.pow(clamp01(c.reliability), w.reliability) *
    Math.pow(completion, w.completion) *
    Math.pow(clamp01(c.availability), w.availability)
  );
}

/** Token multiplier for given normalized inputs. Exposed for UI estimates. */
export function tokenMultiplier(normCompute: number, normToken: number, cfg: RewardConfig = defaultRewardConfig): number {
  if (!(normCompute > 0)) return 0;
  const lambda = cfg.nonHolderBaseline;
  const effToken = Math.max(normToken, lambda * normCompute);
  const base = Math.sqrt(normCompute * effToken);
  return Math.min(base / (Math.sqrt(lambda) * normCompute), cfg.maxMultiplier);
}

export function computeEpoch(
  contributors: ContributorInput[],
  poolUsd: number,
  cfg: RewardConfig = defaultRewardConfig,
): EpochAllocation {
  const eligible = contributors.filter((c) => !eligibility(c, cfg));
  const n = eligible.length;
  const totalCompute = eligible.reduce((s, c) => s + c.verifiedCompute, 0);
  const tokenShareOf = (c: ContributorInput) => Math.min(c.tokenAmount / cfg.circulatingSupply, cfg.tokenShareCap);
  const meanToken = n > 0 ? eligible.reduce((s, c) => s + tokenShareOf(c), 0) / n : 0;
  const lambda = cfg.nonHolderBaseline;

  const rows: ContributorReward[] = contributors.map((c) => {
    const reason = eligibility(c, cfg);
    const computeShare = reason || totalCompute === 0 ? 0 : c.verifiedCompute / totalCompute;
    const tokenShare = tokenShareOf(c);
    const normCompute = computeShare * n;
    const normToken = meanToken > 0 ? Math.pow(tokenShare / meanToken, cfg.tokenExponent) : 0;
    const multiplier = reason ? 0 : tokenMultiplier(normCompute, normToken, cfg);
    const baseScore = reason ? 0 : Math.sqrt(normCompute * Math.max(normToken, lambda * normCompute));
    const quality = reason ? 0 : qualityFactor(c, cfg);
    const score = reason ? 0 : Math.sqrt(lambda) * normCompute * multiplier * quality;
    return {
      id: c.id,
      eligible: !reason,
      reason,
      computeShare,
      tokenShare,
      normCompute,
      normToken,
      baseScore,
      multiplier,
      quality,
      score,
      rewardWeight: 0,
      payout: 0,
      capped: false,
    };
  });

  const totalScore = rows.reduce((s, r) => s + r.score, 0);
  if (totalScore > 0) for (const r of rows) r.rewardWeight = r.score / totalScore;

  waterFill(rows, effectiveCap(rows.filter((r) => r.eligible).length, cfg));
  for (const r of rows) r.payout = r.rewardWeight * poolUsd;
  const distributed = rows.reduce((s, r) => s + r.payout, 0);
  return { poolUsd, distributedUsd: distributed, undistributedUsd: Math.max(0, poolUsd - distributed), rewards: rows };
}

/** Cap each weight at `cap`, redistribute the excess proportionally to uncapped rows. */
/** Per-wallet cap for this epoch: 1/eligible wallets, clamped between the floor and the small-network ceiling. */
export function effectiveCap(eligibleWallets: number, cfg: RewardConfig): number {
  const ceiling = cfg.maxNodeShareWhenSmall ?? cfg.maxNodeShareOfPool;
  if (eligibleWallets <= 0) return ceiling;
  return Math.min(ceiling, Math.max(cfg.maxNodeShareOfPool, 1 / eligibleWallets));
}

function waterFill(rows: ContributorReward[], cap: number) {
  for (let iter = 0; iter < 64; iter++) {
    let excess = 0;
    for (const r of rows) {
      if (r.rewardWeight > cap + 1e-12) {
        excess += r.rewardWeight - cap;
        r.rewardWeight = cap;
        r.capped = true;
      }
    }
    if (excess <= 1e-12) return;
    const open = rows.filter((r) => !r.capped && r.rewardWeight > 0);
    const openTotal = open.reduce((s, r) => s + r.rewardWeight, 0);
    if (openTotal <= 0) return; // nobody left to absorb: remainder is undistributed
    for (const r of open) r.rewardWeight += excess * (r.rewardWeight / openTotal);
  }
}
