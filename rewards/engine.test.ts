import { describe, expect, it } from "vitest";
import { allocate, defaultEngineConfig, holdingMultiplier, type EngineInput } from "./engine";

const node = (nodeId: string, verifiedCompute: number, tokenOwnership = 0, reputation = 0.95, reliability = 0.98): EngineInput => ({ nodeId, verifiedCompute, tokenOwnership, reputation, reliability });
const supply = defaultEngineConfig.circulatingSupply;
const POOL = 1000;

describe("reward engine", () => {
  it("ZERO VERIFIED COMPUTE ALWAYS PRODUCES ZERO REWARD, even for the largest holder", () => {
    const r = allocate([node("whale", 0, supply * 0.5), node("gpu", 100)], POOL);
    const whale = r.rows.find((x) => x.nodeId === "whale")!;
    expect(whale.reward).toBe(0);
    expect(whale.eligible).toBe(false);
    expect(whale.reason).toBe("zero-compute");
    expect(r.rows.find((x) => x.nodeId === "gpu")!.reward).toBeCloseTo(POOL);
    // Degenerate inputs can't sneak through either.
    for (const bad of [NaN, -5, Infinity * 0]) expect(allocate([node("x", bad, supply)], POOL).rows[0].reward).toBe(0);
  });

  it("small holder with a strong GPU out-earns a large holder with a weak GPU", () => {
    const r = allocate([node("small+strong", 1000, 1_000), node("large+weak", 100, supply * 0.05)], POOL);
    const strong = r.rows[0];
    const weak = r.rows[1];
    expect(strong.reward).toBeGreaterThan(weak.reward * 5);
  });

  it("large holder with a strong GPU earns more than the same GPU without tokens, but only up to the cap", () => {
    const r = allocate([node("holder", 1000, supply * 0.05), node("nobody", 1000, 0)], POOL);
    const holder = r.rows[0];
    const nobody = r.rows[1];
    expect(holder.reward).toBeGreaterThan(nobody.reward);
    expect(holder.holdingMultiplier).toBeLessThanOrEqual(defaultEngineConfig.maxHoldingMultiplier);
    expect(holder.reward / nobody.reward).toBeLessThanOrEqual(defaultEngineConfig.maxHoldingMultiplier + 1e-9);
    // 5% of supply is clamped to the 1% cap: identical multiplier to a 1% holder.
    expect(holdingMultiplier(supply * 0.05)).toBeCloseTo(holdingMultiplier(supply * 0.01));
  });

  it("sybil: splitting one account's compute across many nodes never earns more than one node", () => {
    const compute = 1000;
    const tokens = supply * 0.002;
    const rivals = Array.from({ length: 6 }, (_, i) => node(`r${i}`, 800));
    const single = allocate([{ ...node("one", compute, tokens), accountId: "W" }, ...rivals], POOL).rows[0].reward;
    const parts = Array.from({ length: 10 }, (_, i) => ({ ...node(`s${i}`, compute / 10, tokens / 10), accountId: "W" }));
    const split = allocate([...parts, ...rivals], POOL).rows.slice(0, 10).reduce((s, r) => s + r.reward, 0);
    expect(split).toBeLessThanOrEqual(single + 1e-9);
    // Holdings cannot be multiplied by spreading them: each shard sees a smaller normalized share.
    expect(parts.map((p) => holdingMultiplier(p.tokenOwnership)).every((m) => m <= holdingMultiplier(tokens))).toBe(true);
  });

  it("sybil: the cap is per account, so a whale cannot escape it by running many nodes", () => {
    const rivals = Array.from({ length: 6 }, (_, i) => node(`r${i}`, 100));
    const whaleNodes = Array.from({ length: 8 }, (_, i) => ({ ...node(`w${i}`, 10_000), accountId: "WHALE" }));
    const r = allocate([...whaleNodes, ...rivals], POOL);
    const whaleTotal = r.rows.filter((x) => x.accountId === "WHALE").reduce((s, x) => s + x.reward, 0);
    expect(whaleTotal).toBeCloseTo(POOL * defaultEngineConfig.maxAccountShare, 6);
    expect(r.capLifted).toBe(false);
  });

  it("unreliable node earns nothing; a merely mediocre one is scaled by reputation × reliability", () => {
    const r = allocate([node("bad", 1000, 0, 0.9, 0.2), node("meh", 1000, 0, 0.6, 0.8), node("good", 1000, 0, 1, 1)], POOL);
    expect(r.rows[0].reward).toBe(0);
    expect(r.rows[0].reason).toBe("low-reliability");
    expect(r.rows[1].qualityMultiplier).toBeCloseTo(0.48);
    expect(r.rows[1].reward).toBeCloseTo(r.rows[2].reward * 0.48, 6);
  });

  it("caps any single account at maxAccountShare and redistributes; pool is never over-distributed", () => {
    const r = allocate([node("giant", 1_000_000), ...Array.from({ length: 12 }, (_, i) => node(`n${i}`, 100))], POOL);
    const giant = r.rows[0];
    expect(giant.capped).toBe(true);
    expect(giant.share).toBeCloseTo(defaultEngineConfig.maxAccountShare);
    expect(r.distributed).toBeLessThanOrEqual(POOL + 1e-9);
    expect(r.distributed + r.undistributed).toBeCloseTo(POOL);
  });

  it("lifts the cap when too few accounts exist for it to be satisfiable", () => {
    const r = allocate([node("a", 900), node("b", 100)], POOL);
    expect(r.capLifted).toBe(true);
    expect(r.rows[0].reward).toBeCloseTo(900);
    expect(r.undistributed).toBeCloseTo(0);
  });

  it("with alpha = 0 token holdings change nothing", () => {
    const cfg = { ...defaultEngineConfig, alpha: 0 };
    const r = allocate([node("a", 500, supply), node("b", 500, 0)], POOL, 1, cfg);
    expect(r.rows[0].reward).toBeCloseTo(r.rows[1].reward);
  });

  it("empty pool or no eligible nodes distributes nothing", () => {
    expect(allocate([node("a", 100)], 0).distributed).toBe(0);
    const r = allocate([node("a", 0, supply)], POOL);
    expect(r.distributed).toBe(0);
    expect(r.undistributed).toBe(POOL);
  });
});
