import { describe, expect, it } from "vitest";
import type { ExecutionEstimate } from "@/domain/economy";
import { scoreEstimates } from "./router";

const est = (over: Partial<ExecutionEstimate> & Pick<ExecutionEstimate, "provider" | "target">): ExecutionEstimate => ({
  model: "m",
  supported: true,
  available: true,
  estimatedCost: null,
  costBasis: null,
  estimatedLatency: null,
  latencyBasis: null,
  estimatedReliability: 0.95,
  availableCapacity: 1,
  qualityTier: null,
  confidence: 0.5,
  notes: [],
  ...over,
});

const browser = est({ provider: "brain-browser-pool", target: "BROWSER_NETWORK", estimatedCost: 0.002, estimatedLatency: 3000, estimatedReliability: 0.9 });
const cloud = est({ provider: "cloud-fallback", target: "CLOUD_GPU", estimatedCost: 0.01, estimatedLatency: 800, estimatedReliability: 0.98, qualityTier: 0.6 });
const external = est({ provider: "external", target: "EXTERNAL_MODEL", estimatedCost: 0.03, estimatedLatency: 1200, estimatedReliability: 0.99, qualityTier: 0.9 });
// Verified compute carries no plaintext; chat does. Tests default to PUBLIC so the mode is isolated.
const pub = { privacy: "PUBLIC" as const };

describe("route selection", () => {
  it("CHEAP picks the lowest known cost", () => {
    expect(scoreEstimates([browser, cloud, external], "CHEAP", pub).selected?.provider).toBe("brain-browser-pool");
  });
  it("FAST picks the lowest measured latency", () => {
    expect(scoreEstimates([browser, cloud, external], "FAST", pub).selected?.provider).toBe("cloud-fallback");
  });
  it("QUALITY picks the highest configured quality tier and penalises UNKNOWN tiers", () => {
    const r = scoreEstimates([browser, cloud, external], "QUALITY", pub);
    expect(r.selected?.provider).toBe("external");
    expect(r.ranked.find((x) => x.provider === "brain-browser-pool")!.qualityPenalty).toBe(1);
  });
  it("BROWSER_ONLY never selects another target, even when it is the only unavailable one", () => {
    const r = scoreEstimates([{ ...browser, available: false, notes: ["no real nodes online"] }, cloud], "BROWSER_ONLY", pub);
    expect(r.selected).toBeNull();
    expect(r.reason).toMatch(/no eligible target/);
  });
  it("unknown cost is penalised, not treated as free", () => {
    const mystery = est({ provider: "mystery", target: "EXTERNAL_MODEL", estimatedCost: null, estimatedLatency: 500, estimatedReliability: 0.99 });
    const r = scoreEstimates([browser, mystery], "CHEAP", pub);
    expect(r.selected?.provider).toBe("brain-browser-pool");
    expect(r.ranked.find((x) => x.provider === "mystery")!.normalizedCost).toBe(1);
  });
  it("hard constraints exclude candidates and explain why", () => {
    const r = scoreEstimates([browser, cloud], "AUTO", { ...pub, maxLatency: 1000 });
    expect(r.selected?.provider).toBe("cloud-fallback");
    expect(r.ranked.find((x) => x.provider === "brain-browser-pool")!.notes.join()).toMatch(/over maxLatency/);
  });
  it("unsupported capabilities are never selected", () => {
    const r = scoreEstimates([{ ...browser, supported: false }, { ...cloud, available: false }], "AUTO", pub);
    expect(r.selected).toBeNull();
  });
  it("weights are configurable: a reliability-only weighting prefers the most reliable", () => {
    const r = scoreEstimates([browser, cloud, external], "AUTO", pub, { costWeight: 0, latencyWeight: 0, reliabilityWeight: 1, qualityWeight: 0, unknownPenalty: 1 });
    expect(r.selected?.provider).toBe("external");
  });
});

describe("privacy constraint", () => {
  const browserChat = { ...browser, supported: true };
  it("STANDARD excludes untrusted distributed nodes for plaintext requests", () => {
    const r = scoreEstimates([browserChat, cloud, external], "CHEAP", { privacy: "STANDARD" });
    expect(r.selected?.provider).toBe("cloud-fallback");
    expect(r.ranked.find((x) => x.provider === "brain-browser-pool")!.notes.join()).toMatch(/privacy STANDARD/);
  });
  it("PRIVATE allows operator-controlled targets only", () => {
    const r = scoreEstimates([browserChat, cloud, external], "CHEAP", { privacy: "PRIVATE" });
    expect(r.ranked.filter((x) => x.eligible).map((x) => x.provider)).toEqual(["cloud-fallback"]);
    const none = scoreEstimates([browserChat, external], "AUTO", { privacy: "PRIVATE" });
    expect(none.selected).toBeNull();
  });
  it("privacy does not restrict workloads that carry no plaintext", () => {
    const r = scoreEstimates([browser, cloud], "CHEAP", { privacy: "PRIVATE", carriesPlaintext: false });
    expect(r.selected?.provider).toBe("brain-browser-pool");
  });
  it("privacy is a hard constraint: a cheaper excluded target never wins", () => {
    const cheapExternal = { ...external, estimatedCost: 0.0001 };
    expect(scoreEstimates([cloud, cheapExternal], "CHEAP", { privacy: "PRIVATE" }).selected?.provider).toBe("cloud-fallback");
  });
});

describe("COMMUNITY mode", () => {
  // A real node with worse numbers than the external model on every axis the score reads.
  const native = est({ provider: "brain-native-pool", target: "NATIVE_NETWORK", model: "qwen/qwen2.5-1.5b-instruct", estimatedCost: 0.03, estimatedLatency: 9000, estimatedReliability: 0.85 });
  it("takes an eligible community GPU node first even when it scores worse, and keeps the AUTO ranking behind it as the fallback", () => {
    expect(scoreEstimates([native, cloud, external], "AUTO", pub).selected?.provider).not.toBe("brain-native-pool");
    const r = scoreEstimates([native, cloud, external], "COMMUNITY", pub);
    expect(r.selected?.provider).toBe("brain-native-pool");
    expect(r.reason).toContain("community GPU node (taken first)");
    const rest = r.ranked.slice(1).map((x) => x.provider);
    expect(rest).toEqual(scoreEstimates([cloud, external], "AUTO", pub).ranked.map((x) => x.provider));
  });
  it("falls back to the AUTO ranking when no node can take the request", () => {
    const r = scoreEstimates([{ ...native, available: false, notes: ["no node online"] }, cloud, external], "COMMUNITY", pub);
    expect(r.selected?.provider).toBe(scoreEstimates([cloud, external], "AUTO", pub).selected?.provider);
    expect(r.reason).toContain("no community GPU node could take it");
  });
  it("never sends a customer to the mock model and never bypasses the privacy gate", () => {
    expect(scoreEstimates([{ ...native, model: "brain/mock" }, cloud], "COMMUNITY", pub).selected?.provider).toBe("cloud-fallback");
    expect(scoreEstimates([native, cloud], "COMMUNITY", { privacy: "STANDARD" }).selected?.provider).toBe("cloud-fallback");
  });
});

describe("tool calling capability", async () => {
  const { classify } = await import("./plan");
  const { wantsTools } = await import("@/domain/chat");
  const tool = { type: "function" as const, function: { name: "f" } };
  it("classifies a request with tools as needing the tools capability, unless tool_choice is none", () => {
    const base = { kind: "chat" as const, model: "brain/auto", messages: [{ role: "user" as const, content: "hi" }] };
    expect(classify({ ...base, tools: [tool] }).capability).toBe("tools");
    expect(classify({ ...base, tools: [tool], tool_choice: "none" }).capability).toBe("chat");
    expect(classify({ ...base }).capability).toBe("chat");
    expect(wantsTools([], "auto")).toBe(false);
  });
});
