import { defaultRevenueSplit, defaultRewardConfig, type RewardConfig } from "./config";
import { computeEpoch, tokenMultiplier, type ContributorInput } from "./formula";
import { baselineMetrics, meanComputeScore, networkAggregates, revenue } from "@/services/mock/mockData";

/**
 * ILLUSTRATIVE estimates. Uses the real formula against the synthetic network in
 * services/mock/mockData.ts. Every number returned here is labeled "estimated" in the UI.
 */

export interface EstimateInput {
  computeScore: number;
  tokenAmount: number;
  /** 0..1 fraction of the day online. */
  availability?: number;
  reliability?: number;
}

export interface RewardEstimate {
  tokenShare: number;
  normCompute: number;
  normToken: number;
  multiplier: number;
  dailyUsd: number;
  perUnitUsd: number;
  contributorPoolUsd: number;
  provenance: "estimated";
}

export function contributorPoolToday(): number {
  const today = revenue.find((r) => r.period === "today")!;
  return (
    today.creatorRewardsUsd * defaultRevenueSplit.creatorRewards.contributors +
    today.inferenceRevenueUsd * defaultRevenueSplit.inferenceRevenue.contributors
  );
}

/** Synthetic: verified units the whole network produces per day. */
export function networkUnitsPerDay(): number {
  // A node with score S running for a day at mean availability produces ~S·unitsPerScorePerDay units.
  return baselineMetrics.gpusOnline * meanComputeScore * networkAggregates.unitsPerScorePerDay * networkAggregates.meanAvailability;
}

export function estimateReward(input: EstimateInput, cfg: RewardConfig = defaultRewardConfig): RewardEstimate {
  const availability = input.availability ?? 0.9;
  const reliability = input.reliability ?? 0.95;
  const tokenShare = Math.min(input.tokenAmount / cfg.circulatingSupply, cfg.tokenShareCap);
  const normCompute = (input.computeScore * availability) / (meanComputeScore * networkAggregates.meanAvailability);
  const normToken = Math.pow(tokenShare / networkAggregates.meanContributorTokenShare, cfg.tokenExponent);
  const multiplier = input.computeScore > 0 ? tokenMultiplier(normCompute, normToken, cfg) : 0;
  const quality = reliability * Math.pow(availability, cfg.qualityWeights.availability);

  const pool = contributorPoolToday();
  const networkScore =
    baselineMetrics.gpusOnline * networkAggregates.meanMultiplier * networkAggregates.meanQuality * Math.sqrt(cfg.nonHolderBaseline);
  const myScore = Math.sqrt(cfg.nonHolderBaseline) * normCompute * multiplier * quality;
  const share = Math.min(myScore / (networkScore + myScore), cfg.maxNodeShareOfPool);
  const dailyUsd = pool * share;
  const myUnits = input.computeScore * networkAggregates.unitsPerScorePerDay * availability;
  return {
    tokenShare,
    normCompute,
    normToken,
    multiplier,
    dailyUsd,
    perUnitUsd: myUnits > 0 ? dailyUsd / myUnits : 0,
    contributorPoolUsd: pool,
    provenance: "estimated",
  };
}

/** Run a full synthetic epoch — used by the economics simulator and tests. */
export function simulateEpoch(contributors: ContributorInput[], poolUsd = contributorPoolToday(), cfg = defaultRewardConfig) {
  return computeEpoch(contributors, poolUsd, cfg);
}
