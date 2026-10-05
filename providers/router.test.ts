import { describe, expect, it } from "vitest";
import { rankCandidates } from "./router";
import type { Candidate } from "./types";

const cand = (o: Partial<Candidate> & Pick<Candidate, "target" | "providerId">): Candidate => ({
  compatible: true,
  available: true,
  notes: [],
  estLatencyMs: 1000,
  costPer1M: null,
  reliability: 0.95,
  capacity: 1,
  ...o,
});

describe("router", () => {
  it("never selects an incompatible or unavailable target", () => {
    const d = rankCandidates("brain/qwen", [
      cand({ target: "BROWSER_NETWORK", providerId: "browser", compatible: false, notes: ["model not served"] }),
      cand({ target: "CLOUD_FALLBACK", providerId: "cloud", available: false }),
      cand({ target: "EXTERNAL_MODEL_PROVIDER", providerId: "ext" }),
    ]);
    expect(d.selected?.providerId).toBe("ext");
    expect(d.ranked.filter((c) => c.eligible).map((c) => c.providerId)).toEqual(["ext"]);
  });

  it("returns no selection when nothing is eligible", () => {
    const d = rankCandidates("brain/auto", [cand({ target: "CLOUD_FALLBACK", providerId: "cloud", available: false })]);
    expect(d.selected).toBeNull();
  });

  it("prefers the browser network when it is eligible and comparable", () => {
    const d = rankCandidates("brain/embed", [
      cand({ target: "CLOUD_FALLBACK", providerId: "cloud" }),
      cand({ target: "BROWSER_NETWORK", providerId: "browser" }),
    ]);
    expect(d.selected?.providerId).toBe("browser");
  });

  it("lets a much faster, more reliable target beat the network preference", () => {
    const d = rankCandidates("brain/qwen", [
      cand({ target: "BROWSER_NETWORK", providerId: "browser", estLatencyMs: 12_000, reliability: 0.4, capacity: 0.1 }),
      cand({ target: "CLOUD_FALLBACK", providerId: "cloud", estLatencyMs: 400, reliability: 0.99 }),
    ]);
    expect(d.selected?.providerId).toBe("cloud");
  });

  it("does not treat unknown cost as free", () => {
    const d = rankCandidates("brain/auto", [
      cand({ target: "CLOUD_FALLBACK", providerId: "unknown", costPer1M: null }),
      cand({ target: "EXTERNAL_MODEL_PROVIDER", providerId: "cheap", costPer1M: 0.1 }),
    ]);
    expect(d.selected?.providerId).toBe("cheap");
  });
});
