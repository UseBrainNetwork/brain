/**
 * Reward formula parameters. Every knob is here; nothing in formula.ts is a magic number.
 * See rewards/formula.ts for how each is used and rewards/formula.test.ts for the guarantees.
 */
export interface RewardConfig {
  /**
   * λ — how much token weight a non-holder is credited with, relative to their own compute.
   * effectiveToken = max(normToken, λ · normCompute). Average proportional holder earns √(1/λ)×.
   */
  nonHolderBaseline: number;
  /** Token share of supply above this counts no further (anti-whale). 0.01 = 1% of supply. */
  tokenShareCap: number;
  /**
   * Exponent applied to normalized token weight before the geometric mean.
   * 1 = Sybil-neutral. <1 adds diminishing returns but slightly rewards splitting wallets.
   */
  tokenExponent: number;
  /**
   * Hard ceiling on the token multiplier. Bounds every node's reward by its own compute.
   * Kept equal to rewards/engine.ts maxHoldingMultiplier (1.35) so the calculator never promises
   * more than settlement pays.
   */
  maxMultiplier: number;
  /** Exponents on quality factors (0 disables a factor). */
  qualityWeights: { reliability: number; completion: number; availability: number };
  /** Below this verification pass rate a node earns nothing for the epoch. */
  minVerificationPassRate: number;
  /** verifiedCompute must exceed this. Holding tokens alone NEVER earns. */
  minVerifiedCompute: number;
  /** Floor of the per-wallet pool cap: no wallet ever takes more than this once the network is large. */
  maxNodeShareOfPool: number;
  /**
   * Ceiling of the per-wallet cap while few wallets are eligible. The effective cap is
   * clamp(1 / eligibleWallets, maxNodeShareOfPool, maxNodeShareWhenSmall), so a handful of early
   * wallets can actually receive the pool instead of most of it returning to the treasury.
   */
  maxNodeShareWhenSmall: number;
  circulatingSupply: number;
}

export const defaultRewardConfig: RewardConfig = {
  nonHolderBaseline: 0.5,
  tokenShareCap: 0.01,
  tokenExponent: 1,
  maxMultiplier: 1.35,
  qualityWeights: { reliability: 1, completion: 1, availability: 0.5 },
  minVerificationPassRate: 0.9,
  minVerifiedCompute: 0,
  maxNodeShareOfPool: 0.02,
  maxNodeShareWhenSmall: 0.25,
  circulatingSupply: 1_000_000_000,
};

/**
 * buyback: market-buys the token on a published schedule; purchased tokens are burned.
 * Buybacks are ordinary trades, so they pay creator fees like any other trade.
 */
export interface RevenueSplit {
  contributors: number;
  buyback: number;
  infrastructure: number;
  treasury: number;
}

/** How incoming value is split. Must each sum to 1. */
export interface RevenueSplitConfig {
  creatorRewards: RevenueSplit;
  inferenceRevenue: RevenueSplit;
}

export const defaultRevenueSplit: RevenueSplitConfig = {
  creatorRewards: { contributors: 0.5, buyback: 0, infrastructure: 0.2, treasury: 0.3 },
  inferenceRevenue: { contributors: 0.6, buyback: 0.3, infrastructure: 0.1, treasury: 0 },
};

/**
 * PLANNED, not implemented: holders receive an inference allowance instead of a cash return.
 * The allowance is paid for out of the inference buyback share, so contributors are still
 * paid in full for serving it.
 */
export const holderAccessPlan = {
  status: "planned" as const,
  /** Fraction of the inference buyback share redirected into the allowance budget. */
  budgetShareOfBuyback: 1 / 3,
  /** Holdings are averaged over this window so borrowed tokens can't qualify. */
  averagingDays: 7,
  /** Holdings above this share of supply add no further allowance (mirrors tokenShareCap). */
  holdingCap: defaultRewardConfig.tokenShareCap,
};
