import { describe, expect, it } from "vitest";
import { CapacityError, DEFAULT_WEIGHTS, scoreNodes, selectNode, type RouteCandidate } from "./score";

const cand = (nodeId: string, extra: Partial<RouteCandidate> = {}): RouteCandidate => ({
  nodeId,
  state: "ONLINE",
  supportedModels: ["qwen/qwen2.5-7b-instruct"],
  loadedModels: ["qwen/qwen2.5-7b-instruct"],
  vramTotalMb: 24_576,
  activeJobs: 0,
  maxConcurrency: 2,
  tokPerSec: null,
  benchmarkScore: 30,
  mock: false,
  reputation: 70,
  rttMs: null,
  region: null,
  askUsdPer1MTokens: null,
  queueDepth: 0,
  ...extra,
});
const W = { model: "qwen/qwen2.5-7b-instruct", minVramMb: 20_000 };

describe("router scoring", () => {
  it("never sends customer work to real hardware that has not been benchmarked; probes may", () => {
    const fresh = cand("N-NEW", { benchmarkScore: null });
    const r = scoreNodes([fresh], W);
    expect(r.selected).toBeNull();
    expect(r.ranked[0].rejections).toContain("not yet benchmarked");
    expect(scoreNodes([fresh], { ...W, allowUnmeasured: true }).selected?.nodeId).toBe("N-NEW");
    // Mock nodes (development) are exempt: they are refused by production coordinators anyway.
    expect(scoreNodes([cand("N-MOCK", { benchmarkScore: null, mock: true, supportedModels: ["brain/mock"], loadedModels: ["brain/mock"] })], { model: "brain/mock", minVramMb: null }).selected?.nodeId).toBe("N-MOCK");
  });

  it("is deterministic and tie-breaks by node id", () => {
    const a = scoreNodes([cand("N-B"), cand("N-A")], W);
    const b = scoreNodes([cand("N-A"), cand("N-B")], W);
    expect(a.ranked.map((r) => r.nodeId)).toEqual(["N-A", "N-B"]);
    expect(b.ranked.map((r) => r.nodeId)).toEqual(["N-A", "N-B"]);
    expect(a.selected?.total).toBe(b.selected?.total);
  });

  it("rejects on hard constraints with named reasons", () => {
    const r = scoreNodes(
      [
        cand("N-OFF", { state: "OFFLINE" }),
        cand("N-BUSY", { state: "BUSY", activeJobs: 2 }),
        cand("N-SMALL", { vramTotalMb: 8_000 }),
        cand("N-OTHER", { supportedModels: ["brain/mock"], loadedModels: [] }),
        cand("N-DRAIN", { state: "DRAINING" }),
        cand("N-DEG", { state: "DEGRADED" }),
      ],
      W,
    );
    expect(r.selected).toBeNull();
    const by = Object.fromEntries(r.ranked.map((x) => [x.nodeId, x.rejections]));
    expect(by["N-OFF"]).toEqual(["offline"]);
    expect(by["N-BUSY"]).toEqual(["no free slot"]);
    expect(by["N-SMALL"][0]).toMatch(/VRAM 8 GB < 20 GB required/);
    expect(by["N-OTHER"][0]).toMatch(/does not serve/);
    expect(by["N-DRAIN"]).toEqual(["draining"]);
    expect(by["N-DEG"]).toEqual(["degraded"]);
    expect(r.reason).toMatch(/^0 of 6 nodes can serve/);
    expect(() => selectNode([cand("N-OFF", { state: "OFFLINE" })], W)).toThrow(CapacityError);
  });

  it("prefers loaded, faster, less loaded, better-reputed, cheaper nodes", () => {
    const base = cand("N-BASE");
    expect(scoreNodes([base, cand("N-COLD", { loadedModels: [] })], W).selected?.nodeId).toBe("N-BASE");
    expect(scoreNodes([cand("N-SLOW", { tokPerSec: 10 }), cand("N-FAST", { tokPerSec: 40 })], W).selected?.nodeId).toBe("N-FAST");
    expect(scoreNodes([base, cand("N-LOADED", { activeJobs: 1 })], W).selected?.nodeId).toBe("N-BASE");
    expect(scoreNodes([base, cand("N-GOOD", { reputation: 95 })], W).selected?.nodeId).toBe("N-GOOD");
    expect(scoreNodes([cand("N-DEAR", { askUsdPer1MTokens: 2 }), cand("N-CHEAP", { askUsdPer1MTokens: 0.5 })], W).selected?.nodeId).toBe("N-CHEAP");
    expect(scoreNodes([cand("N-FAR", { rttMs: 250 }), cand("N-NEAR", { rttMs: 20 })], W).selected?.nodeId).toBe("N-NEAR");
  });

  it("scores unknowns as neutral and says so", () => {
    const r = scoreNodes([cand("N-A", { benchmarkScore: null })], { ...W, allowUnmeasured: true });
    expect(r.selected?.latency).toBe(0.5);
    expect(r.selected?.price).toBe(0.5);
    expect(r.selected?.notes).toEqual(expect.arrayContaining(["speed unmeasured", "rtt unmeasured", "no price ask"]));
  });

  it("passes unknown VRAM with a note unless the workload requires it", () => {
    const c = cand("N-NOVRAM", { vramTotalMb: null });
    expect(scoreNodes([c], W).selected?.nodeId).toBe("N-NOVRAM");
    expect(scoreNodes([c], { ...W, requireKnownVram: true }).selected).toBeNull();
  });

  it("region is a preference by default and a constraint when required", () => {
    const eu = cand("N-EU", { region: "eu-west" });
    const us = cand("N-US", { region: "us-east" });
    expect(scoreNodes([us, eu], { ...W, region: "eu-west" }).selected?.nodeId).toBe("N-EU");
    expect(scoreNodes([us], { ...W, region: "eu-west" }).selected?.nodeId).toBe("N-US");
    expect(scoreNodes([us], { ...W, region: "eu-west", requireRegion: true }).selected).toBeNull();
  });

  it("weights sum to one and totals stay in [0,1]", () => {
    expect(Object.values(DEFAULT_WEIGHTS).reduce((s, x) => s + x, 0)).toBeCloseTo(1);
    const r = scoreNodes([cand("N-A", { tokPerSec: 50, rttMs: 10, reputation: 100, askUsdPer1MTokens: 0.1 })], W);
    expect(r.selected!.total).toBeGreaterThan(0);
    expect(r.selected!.total).toBeLessThanOrEqual(1);
  });
});
