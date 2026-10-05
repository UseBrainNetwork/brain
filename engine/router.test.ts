import { describe, expect, it } from "vitest";
import type { ExecutionEstimate } from "@/domain/economy";
import { scoreEstimates } from "./router";

const est = (over: Partial<ExecutionEstimate> & Pick<ExecutionEstimate, "provider" | "target">): ExecutionEstimate => ({
  estimatedCost: null,
  costBasis: null,
  estimatedLatency: null,
  latencyBasis: null,
  capacity: 1,
  modelSupported: true,
  available: true,
  confidence: 0.5,
  reliability: 0.95,
  notes: [],
  ...over,
});

const browser = est({ provider: "brain-browser-pool", target: "BROWSER_NETWORK", estimatedCost: 0.002, estimatedLatency: 3000, reliability: 0.9 });
const cloud = est({ provider: "cloud-fallback", target: "CLOUD_GPU", estimatedCost: 0.01, estimatedLatency: 800, reliability: 0.98 });
const external = est({ provider: "external", target: "EXTERNAL_PROVIDER", estimatedCost: 0.03, estimatedLatency: 1200, reliability: 0.99 });

describe("route selection", () => {
  it("CHEAPEST picks the lowest known cost", () => {
    expect(scoreEstimates([browser, cloud, external], "CHEAPEST").selected?.provider).toBe("brain-browser-pool");
  });
  it("FASTEST picks the lowest measured latency", () => {
    expect(scoreEstimates([browser, cloud, external], "FASTEST").selected?.provider).toBe("cloud-fallback");
  });
  it("BROWSER_ONLY never selects another target, even when it is the only unavailable one", () => {
    const r = scoreEstimates([{ ...browser, available: false, notes: ["no real nodes online"] }, cloud], "BROWSER_ONLY");
    expect(r.selected).toBeNull();
    expect(r.reason).toMatch(/no eligible target/);
  });
  it("unknown cost is penalised, not treated as free", () => {
    const mystery = est({ provider: "mystery", target: "EXTERNAL_PROVIDER", estimatedCost: null, estimatedLatency: 500, reliability: 0.99 });
    const r = scoreEstimates([browser, mystery], "CHEAPEST");
    expect(r.selected?.provider).toBe("brain-browser-pool");
    expect(r.ranked.find((x) => x.provider === "mystery")!.normalizedCost).toBe(1);
  });
  it("hard constraints exclude candidates and explain why", () => {
    const r = scoreEstimates([browser, cloud], "AUTO", { maxLatency: 1000 });
    expect(r.selected?.provider).toBe("cloud-fallback");
    expect(r.ranked.find((x) => x.provider === "brain-browser-pool")!.notes.join()).toMatch(/over maxLatency/);
  });
  it("unsupported models are never selected", () => {
    const r = scoreEstimates([{ ...browser, modelSupported: false }, { ...cloud, available: false }], "AUTO");
    expect(r.selected).toBeNull();
  });
  it("weights are configurable: a reliability-only weighting prefers the most reliable", () => {
    const r = scoreEstimates([browser, cloud, external], "AUTO", {}, { costWeight: 0, latencyWeight: 0, reliabilityWeight: 1, unknownPenalty: 1 });
    expect(r.selected?.provider).toBe("external");
  });
});
