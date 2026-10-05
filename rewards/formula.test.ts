import { describe, expect, it } from "vitest";
import { defaultRevenueSplit, defaultRewardConfig, type RewardConfig } from "./config";
import { computeEpoch, tokenMultiplier, type ContributorInput } from "./formula";
import { estimateReward } from "./simulate";

const cfg: RewardConfig = { ...defaultRewardConfig, maxNodeShareOfPool: 1 };

function node(id: string, compute: number, tokens = 0, extra: Partial<ContributorInput> = {}): ContributorInput {
  return {
    id,
    verifiedCompute: compute,
    tokenAmount: tokens,
    reliability: 1,
    jobsAssigned: 100,
    jobsCompleted: 100,
    availability: 1,
    verificationPassRate: 1,
    ...extra,
  };
}

const byId = (alloc: ReturnType<typeof computeEpoch>, id: string) => alloc.rewards.find((r) => r.id === id)!;

describe("eligibility", () => {
  it("never rewards holding tokens without verified compute", () => {
    const a = computeEpoch([node("whale", 0, 50_000_000), node("worker", 1000)], 1000, cfg);
    expect(byId(a, "whale").payout).toBe(0);
    expect(byId(a, "whale").reason).toBe("no-verified-compute");
    expect(byId(a, "worker").payout).toBeCloseTo(1000);
  });

  it("excludes banned nodes and nodes failing verification", () => {
    const a = computeEpoch(
      [node("ok", 1000), node("banned", 1000, 0, { banned: true }), node("cheat", 1000, 0, { verificationPassRate: 0.5 })],
      900,
      cfg,
    );
    expect(byId(a, "banned").payout).toBe(0);
    expect(byId(a, "cheat").reason).toBe("verification-below-threshold");
    expect(byId(a, "ok").payout).toBeCloseTo(900);
  });

  it("returns zero allocation when nobody is eligible", () => {
    const a = computeEpoch([node("a", 0, 1e6)], 500, cfg);
    expect(a.distributedUsd).toBe(0);
    expect(a.undistributedUsd).toBe(500);
  });
});

describe("weights", () => {
  it("sum to 1 across eligible nodes", () => {
    const a = computeEpoch([node("a", 100, 0), node("b", 300, 2_000_000), node("c", 50, 9_000_000)], 1, cfg);
    const sum = a.rewards.reduce((s, r) => s + r.rewardWeight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("non-holders get multiplier 1 and are paid linearly in compute", () => {
    const a = computeEpoch([node("a", 100), node("b", 300)], 400, cfg);
    expect(byId(a, "a").multiplier).toBeCloseTo(1);
    expect(byId(a, "b").payout / byId(a, "a").payout).toBeCloseTo(3);
  });

  it("more verified compute always earns more, holdings equal", () => {
    let prev = 0;
    for (const c of [10, 50, 100, 500, 1000]) {
      const a = computeEpoch([node("me", c, 1_000_000), node("other", 400, 1_000_000)], 1000, cfg);
      const p = byId(a, "me").payout;
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it("an average proportional holder earns sqrt(1/λ)×", () => {
    expect(tokenMultiplier(1, 1, cfg)).toBeCloseTo(Math.sqrt(1 / cfg.nonHolderBaseline));
  });

  it("token weighting has diminishing returns (doubling tokens < doubling reward)", () => {
    const m1 = tokenMultiplier(1, 1, cfg);
    const m2 = tokenMultiplier(1, 2, cfg);
    expect(m2).toBeGreaterThan(m1);
    expect(m2 / m1).toBeLessThan(2);
    expect(m2 / m1).toBeCloseTo(Math.SQRT2);
  });
});

describe("anti-whale", () => {
  it("multiplier is capped by maxMultiplier", () => {
    expect(tokenMultiplier(0.01, 1000, cfg)).toBe(cfg.maxMultiplier);
  });

  it("holdings above tokenShareCap count no further", () => {
    const c = { ...cfg, tokenShareCap: 0.001 };
    const a = computeEpoch([node("a", 100, 1_000_000), node("b", 100, 500_000_000), node("x", 100)], 1, c);
    expect(byId(a, "a").tokenShare).toBe(byId(a, "b").tokenShare);
    expect(byId(a, "a").payout).toBeCloseTo(byId(a, "b").payout);
  });

  it("a whale's reward is bounded by maxMultiplier × its compute weight", () => {
    const a = computeEpoch([node("whale", 100, 10_000_000), node("w1", 100), node("w2", 100)], 1, cfg);
    expect(byId(a, "whale").payout / byId(a, "w1").payout).toBeLessThanOrEqual(cfg.maxMultiplier + 1e-9);
  });

  it("per-node pool cap is enforced and excess redistributed", () => {
    const c = { ...cfg, maxNodeShareOfPool: 0.4 };
    const a = computeEpoch([node("big", 1000), node("s1", 100), node("s2", 100)], 1000, c);
    expect(byId(a, "big").rewardWeight).toBeCloseTo(0.4);
    expect(byId(a, "s1").rewardWeight).toBeCloseTo(0.3);
    expect(a.distributedUsd).toBeCloseTo(1000);
  });

  it("leaves pool undistributed when every node is capped", () => {
    const c = { ...cfg, maxNodeShareOfPool: 0.25 };
    const a = computeEpoch([node("a", 100), node("b", 100)], 100, c);
    expect(a.distributedUsd).toBeCloseTo(50);
    expect(a.undistributedUsd).toBeCloseTo(50);
  });
});

describe("sybil resistance", () => {
  const network = Array.from({ length: 200 }, (_, i) => node(`n${i}`, 100 + (i % 7) * 20, (i % 3) * 400_000));

  it("splitting one non-holder machine into many nodes does not increase reward", () => {
    const whole = computeEpoch([...network, node("me", 1000)], 10_000, cfg);
    const split = computeEpoch([...network, ...Array.from({ length: 10 }, (_, i) => node(`me${i}`, 100))], 10_000, cfg);
    const splitTotal = split.rewards.filter((r) => r.id.startsWith("me")).reduce((s, r) => s + r.payout, 0);
    expect(splitTotal).toBeLessThanOrEqual(byId(whole, "me").payout * 1.01);
  });

  it("splitting compute AND tokens evenly is neutral below the multiplier cap", () => {
    const whole = computeEpoch([...network, node("me", 1000, 2_000_000)], 10_000, cfg);
    const split = computeEpoch(
      [...network, ...Array.from({ length: 4 }, (_, i) => node(`me${i}`, 250, 500_000))],
      10_000,
      cfg,
    );
    const splitTotal = split.rewards.filter((r) => r.id.startsWith("me")).reduce((s, r) => s + r.payout, 0);
    expect(splitTotal / byId(whole, "me").payout).toBeGreaterThan(0.95);
    expect(splitTotal / byId(whole, "me").payout).toBeLessThan(1.05);
  });
});

describe("quality", () => {
  it("lower reliability, completion and availability reduce reward", () => {
    const a = computeEpoch(
      [node("good", 100), node("flaky", 100, 0, { reliability: 0.6, jobsCompleted: 70, availability: 0.5 })],
      1,
      cfg,
    );
    expect(byId(a, "flaky").payout).toBeLessThan(byId(a, "good").payout * 0.5);
  });
});

describe("estimates", () => {
  it("are labeled estimated and zero without compute", () => {
    const e = estimateReward({ computeScore: 0, tokenAmount: 5_000_000 });
    expect(e.provenance).toBe("estimated");
    expect(e.dailyUsd).toBe(0);
  });

  it("increase with holdings but stay bounded", () => {
    const none = estimateReward({ computeScore: 18_000, tokenAmount: 0 });
    const some = estimateReward({ computeScore: 18_000, tokenAmount: 2_481_882 });
    const huge = estimateReward({ computeScore: 18_000, tokenAmount: 900_000_000 });
    expect(none.multiplier).toBeCloseTo(1);
    expect(some.dailyUsd).toBeGreaterThan(none.dailyUsd);
    expect(huge.multiplier).toBeLessThanOrEqual(defaultRewardConfig.maxMultiplier);
  });
});

describe("revenue split", () => {
  it("each source allocates exactly 100%", () => {
    for (const split of [defaultRevenueSplit.creatorRewards, defaultRevenueSplit.inferenceRevenue]) {
      expect(split.contributors + split.buyback + split.infrastructure + split.treasury).toBeCloseTo(1, 10);
    }
  });
  it("inference sales fund buybacks; creator fees do not", () => {
    expect(defaultRevenueSplit.inferenceRevenue.buyback).toBeGreaterThan(0);
    expect(defaultRevenueSplit.creatorRewards.buyback).toBe(0);
  });
});
