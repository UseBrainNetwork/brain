import { describe, expect, it } from "vitest";
import { MemoryStore, mergeNodeCounters, type StoredNode } from "./store";

const base: StoredNode = {
  id: "ABC123",
  sessionHash: "s",
  ipHash: "i",
  walletVerified: false,
  tokenAmount: 0,
  heartbeats: 10,
  clientReportedDevice: "x",
  status: "idle",
  deviceClass: "OTHER_WEBGPU",
  computeScore: 100,
  verifiedJobs: 20,
  failedJobs: 1,
  verifiedComputeUnits: 2000,
  reputation: 0.9,
  joinedAt: 1,
  lastHeartbeatAt: 1,
} as StoredNode;

describe("node counters never roll backwards", () => {
  it("a stale snapshot keeps the newer counters and reputation", () => {
    const fresh = { ...base, verifiedJobs: 21, verifiedComputeUnits: 2012, reputation: 0.91, heartbeats: 11 };
    const stale = { ...base, status: "computing" as const };
    const merged = mergeNodeCounters(fresh, stale);
    expect(merged.status).toBe("computing");
    expect(merged.verifiedComputeUnits).toBe(2012);
    expect(merged.verifiedJobs).toBe(21);
    expect(merged.heartbeats).toBe(11);
    expect(merged.reputation).toBe(0.91);
  });

  it("a genuine increment wins over the stored row", () => {
    const next = { ...base, verifiedJobs: 21, verifiedComputeUnits: 2012, reputation: 0.905 };
    const merged = mergeNodeCounters(base, next);
    expect(merged.verifiedComputeUnits).toBe(2012);
    expect(merged.reputation).toBe(0.905);
  });

  it("two writers with disjoint increments both land", () => {
    const heartbeat = { ...base, heartbeats: 11 };
    const result = { ...base, verifiedJobs: 21, verifiedComputeUnits: 2012, reputation: 0.91 };
    const merged = mergeNodeCounters(result, heartbeat);
    expect(merged.heartbeats).toBe(11);
    expect(merged.verifiedComputeUnits).toBe(2012);
    expect(merged.reputation).toBe(0.91);
  });

  it("MemoryStore.saveNode applies the rule", async () => {
    const s = new MemoryStore();
    await s.saveNode({ ...base, verifiedComputeUnits: 2012, verifiedJobs: 21 });
    await s.saveNode({ ...base, status: "computing" });
    const n = await s.getNode(base.id);
    expect(n?.verifiedComputeUnits).toBe(2012);
    expect(n?.status).toBe("computing");
  });
});
