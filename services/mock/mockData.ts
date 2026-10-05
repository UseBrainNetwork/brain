/**
 * ============================================================================
 *  DEMO DATA — the single source of every simulated number in the product.
 * ============================================================================
 * Nothing here is real. Components never hardcode these values; they read them
 * through services/data.ts, which tags them with provenance "simulated" so the UI
 * can badge them. Replace by implementing the same functions against real APIs.
 */

import type { CreatorRevenue, DeviceClass, ModelPool, NetworkMetrics } from "@/domain/types";
import { defaultRevenueSplit } from "@/rewards/config";
import { mulberry32 } from "@/network/workloads";

export const DEMO = true as const;

export interface DeviceClassProfile {
  id: DeviceClass;
  label: string;
  nodes: number;
  /** GB a node of this class contributes to the pool on average (synthetic). */
  advertisedMemoryGb: number;
  /** Median server-verified compute score (synthetic distribution). */
  medianScore: number;
}

export const deviceClasses: DeviceClassProfile[] = [
  { id: "RTX_4090", label: "RTX 4090", nodes: 2106, advertisedMemoryGb: 8, medianScore: 27_000 },
  { id: "M4_MAX", label: "M4 MAX", nodes: 1284, advertisedMemoryGb: 10, medianScore: 13_000 },
  { id: "RTX_4080", label: "RTX 4080", nodes: 1880, advertisedMemoryGb: 6, medianScore: 19_500 },
  { id: "M3_MAX", label: "M3 MAX", nodes: 1422, advertisedMemoryGb: 7, medianScore: 9_600 },
  { id: "RX_7900", label: "RX 7900", nodes: 968, advertisedMemoryGb: 6, medianScore: 16_500 },
  { id: "OTHER_WEBGPU", label: "OTHER WEBGPU", nodes: 5182, advertisedMemoryGb: 2.25, medianScore: 2_900 },
];

export const deviceLabel = (id: DeviceClass) => deviceClasses.find((d) => d.id === id)?.label ?? id;

const totalNodes = deviceClasses.reduce((s, d) => s + d.nodes, 0);
const totalMemoryGb = deviceClasses.reduce((s, d) => s + d.nodes * d.advertisedMemoryGb, 0);

/** Synthetic $ flows for "today". Payouts are DERIVED from the configured split. */
const creatorRewardsToday = 18_482;
const inferenceRevenueToday = 2_106;
const paidToProvidersToday =
  creatorRewardsToday * defaultRevenueSplit.creatorRewards.contributors +
  inferenceRevenueToday * defaultRevenueSplit.inferenceRevenue.contributors;

export const baselineMetrics: NetworkMetrics = {
  gpusOnline: totalNodes,
  availableMemoryTb: totalMemoryGb / 1000,
  inferencesToday: 4_820_000,
  creatorRewardsTodayUsd: creatorRewardsToday,
  paidToProvidersTodayUsd: Math.round(paidToProvidersToday),
  avgCostPer1MTokensUsd: null, // pending real benchmarks — rendered as $0.XX
  uptimePct: 99.91,
  requestsPerSec: 482,
  capacityScore: 0, // derived in services/data.ts
  liveNodes: 0,
  provenance: "simulated",
};

export const modelPools: ModelPool[] = [
  { id: "qwen-32b", label: "QWEN 32B", model: "brain/qwen", nodes: 4821, status: "online", minMemoryGb: 6, requestsPerSec: 211 },
  { id: "deepseek-distill", label: "DEEPSEEK DISTILL", model: "brain/code", nodes: 2184, status: "online", minMemoryGb: 6, requestsPerSec: 96 },
  { id: "embeddings", label: "EMBEDDINGS", model: "brain/embed", nodes: 1821, status: "online", minMemoryGb: 1, requestsPerSec: 158 },
  { id: "vision", label: "VISION", model: "brain/vision", nodes: 884, status: "beta", minMemoryGb: 8, requestsPerSec: 17 },
];

export const revenue: CreatorRevenue[] = [
  { period: "today", creatorRewardsUsd: creatorRewardsToday, computePayoutsUsd: Math.round(paidToProvidersToday), inferenceRevenueUsd: inferenceRevenueToday, provenance: "simulated" },
  { period: "7d", creatorRewardsUsd: 121_884, computePayoutsUsd: 93_602, inferenceRevenueUsd: 11_870, provenance: "simulated" },
  { period: "30d", creatorRewardsUsd: 482_190, computePayoutsUsd: 368_115, inferenceRevenueUsd: 51_013, provenance: "simulated" },
  { period: "all", creatorRewardsUsd: 1_204_882, computePayoutsUsd: 918_406, inferenceRevenueUsd: 124_590, provenance: "simulated" },
];

export const token = {
  symbol: "BRAIN",
  priceUsd: 0.001842,
  change24hPct: 4.2,
  circulatingSupply: 1_000_000_000,
  provenance: "simulated" as const,
};

/** DEMO SOL/USD rate. Only converts the simulated USD pool into a simulated lamport pool. */
export const demoSolPriceUsd = 150;

/** Synthetic network aggregates used by reward estimates. */
export const networkAggregates = {
  /** Mean token share of supply held by an active contributor. */
  meanContributorTokenShare: 0.0011,
  meanAvailability: 0.82,
  meanQuality: 0.88,
  meanMultiplier: 1.21,
  /**
   * Verified units a node earns per day per point of compute score. Matched to the V1
   * dispatcher pace (≈1 job / 1.6 s, ≈10 units per job for a ~12k-score node) so that
   * per-job estimates add up to the daily estimate.
   */
  unitsPerScorePerDay: 45,
};

export const meanComputeScore =
  deviceClasses.reduce((s, d) => s + d.nodes * d.medianScore, 0) / totalNodes;

/** Percentile of a score against the synthetic network distribution (log-normal per class). */
export function scorePercentile(score: number): number {
  const sigma = 0.38;
  const erf = (x: number) => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  };
  let below = 0;
  for (const d of deviceClasses) {
    const z = (Math.log(Math.max(score, 1)) - Math.log(d.medianScore)) / (sigma * Math.SQRT2);
    below += d.nodes * 0.5 * (1 + erf(z));
  }
  return below / totalNodes;
}

/* ------------------------------------------------------------- contributors */

export interface MockContributor {
  nodeId: string;
  deviceClass: DeviceClass;
  verifiedCompute: number;
  uptimePct: number;
  jobs: number;
  rewardUsd: number;
}

export function topContributors(count = 24): MockContributor[] {
  const rnd = mulberry32(0xb4a1);
  const weighted = deviceClasses.flatMap((d) => Array(Math.ceil(d.medianScore / 4000)).fill(d.id) as DeviceClass[]);
  const rows: MockContributor[] = [];
  for (let i = 0; i < count; i++) {
    const deviceClass = weighted[rnd() % weighted.length];
    const decay = Math.pow(0.93, i);
    rows.push({
      nodeId: (rnd() & 0xffff).toString(16).toUpperCase().padStart(4, "0"),
      deviceClass,
      verifiedCompute: Math.round(9_800_000 * decay + (rnd() % 120_000)),
      uptimePct: 96 + (rnd() % 390) / 100,
      jobs: Math.round(184_000 * decay + (rnd() % 4000)),
      rewardUsd: Math.round((2_480 * decay + (rnd() % 60)) * 100) / 100,
    });
  }
  return rows;
}

/* ------------------------------------------------------------ inference */

export interface InferenceModel {
  id: string;
  name: string;
  description: string;
  pool: string | null;
  context: number;
  /** null = pricing pending benchmarks. */
  networkPricePer1M: number | null;
  referencePricePer1M: number | null;
  status: "routing" | "beta" | "planned";
}

export const inferenceModels: InferenceModel[] = [
  { id: "brain/auto", name: "brain/auto", description: "Automatically chooses the cheapest execution path that satisfies the request.", pool: null, context: 32768, networkPricePer1M: null, referencePricePer1M: null, status: "routing" },
  { id: "brain/qwen", name: "brain/qwen", description: "Distributed Qwen-class inference across the browser pool.", pool: "qwen-32b", context: 32768, networkPricePer1M: null, referencePricePer1M: null, status: "beta" },
  { id: "brain/code", name: "brain/code", description: "Coding-optimized inference on distilled reasoning models.", pool: "deepseek-distill", context: 16384, networkPricePer1M: null, referencePricePer1M: null, status: "beta" },
  { id: "brain/embed", name: "brain/embed", description: "Distributed embeddings. Small model, highly parallel, browser-native.", pool: "embeddings", context: 8192, networkPricePer1M: null, referencePricePer1M: null, status: "beta" },
];
