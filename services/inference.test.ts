import { beforeEach, describe, expect, it, vi } from "vitest";
import { QWEN3_0_6B, QWEN3_1_7B, QWEN3_4B, stagePlan, stageUnits } from "@/inference/config";
import type { PresenceNode } from "@/inference/protocol";
import { assignShard, inferenceCapacity, lookupDrafts, pickModel, reportShard, settleSession, type InferenceSession } from "./inference";
import { MemoryStore, type StoredNode } from "./store";

// The relay is external (Cloudflare); tests control who it reports as connected.
const presence = new Map<string, PresenceNode[]>();
vi.mock("./relay", () => ({
  relayConfigured: () => true,
  relayPresence: async (model: string) => presence.get(model) ?? [],
}));

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };
const store = () => g.__brainStore!;

function node(id: string, extra: Partial<StoredNode> = {}): StoredNode {
  return {
    id,
    deviceClass: "OTHER_WEBGPU",
    status: "idle",
    computeScore: 10_000,
    advertisedMemoryGb: 1,
    maxBufferBytes: 1024 ** 3,
    joinedAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    verifiedJobs: 0,
    failedJobs: 0,
    verifiedComputeUnits: 0,
    reputation: 0.95,
    provenance: "live",
    sessionHash: `s-${id}`,
    ipHash: "ip",
    walletVerified: false,
    tokenAmount: 0,
    heartbeats: 0,
    clientReportedDevice: "",
    ...extra,
  };
}

const present = (model: string, ids: string[], stageOf: (id: string) => number) => presence.set(model, ids.map((nodeId) => ({ nodeId, stage: stageOf(nodeId), since: Date.now() })));

describe("shard assignment ladder", () => {
  beforeEach(async () => {
    g.__brainStore = new MemoryStore();
    presence.clear();
  });

  it("fills the default model to two holders per stage, then the next tier; a node keeps its stage", async () => {
    const ids = "ABCDEFGHIJK".split("");
    const got: string[] = [];
    for (const id of ids) {
      await store().saveNode(node(id));
      const a = await assignShard(node(id));
      got.push(`${a.model.id}:${a.span.stage}`);
    }
    expect(got).toEqual([
      "qwen3-1.7b:0", "qwen3-1.7b:1", "qwen3-1.7b:2", "qwen3-1.7b:3",
      "qwen3-1.7b:0", "qwen3-1.7b:1", "qwen3-1.7b:2", "qwen3-1.7b:3",
      "qwen3-4b:0", "qwen3-4b:1", "qwen3-4b:2",
    ]);
    expect((await assignShard(node("B"))).span.stage).toBe(1);
    expect((await assignShard(node("I"))).model.id).toBe(QWEN3_4B.id);
  });

  it("skips stages that do not fit the node's GPU and never assigns one that cannot fit", async () => {
    // 300 MB: fits the 1.7B middle stages (~190 MB) but not the embedding stages.
    const small = node("S", { maxBufferBytes: 300 * 1024 * 1024 });
    await store().saveNode(small);
    const a = await assignShard(small);
    expect(a.model.id).toBe(QWEN3_1_7B.id);
    expect(a.span.hasEmbed || a.span.hasHead).toBe(false);
    // The limit is per buffer; the largest middle-stage matrix is the FFN (hidden × intermediate, Q4): ~7 MB for
    // 1.7B, ~1.7 MB for 0.6B. A 4 MB node falls through the ladder to a 0.6B middle stage.
    const mid = node("M", { maxBufferBytes: 4 * 1024 * 1024 });
    await store().saveNode(mid);
    expect((await assignShard(mid)).model.id).toBe(QWEN3_0_6B.id);
    const tiny = node("T", { maxBufferBytes: 1024 * 1024 });
    await store().saveNode(tiny);
    await expect(assignShard(tiny)).rejects.toMatchObject({ code: "no_fit" });
  });

  it("capacity counts a node only when its shard is ready and the relay sees it; pickModel prefers the largest verifiable model", async () => {
    expect(stagePlan(QWEN3_0_6B)).toHaveLength(3);
    const ids = ["A", "B", "C", "D", "E", "F"];
    const stages: Record<string, number> = {};
    for (const id of ids) {
      await store().saveNode(node(id));
      stages[id] = (await assignShard(node(id), QWEN3_0_6B)).span.stage;
      if (id !== "F") await reportShard(node(id), { state: "ready" });
    }
    expect(ids.map((id) => stages[id])).toEqual([0, 1, 2, 0, 1, 2]);
    const stageOf = (id: string) => stages[id];
    let cap = await inferenceCapacity(QWEN3_0_6B);
    expect(cap.available).toBe(false);
    expect(cap.stages.map((s) => s.loading)).toEqual([0, 0, 1]);
    present(QWEN3_0_6B.id, ["A", "B", "C", "D", "E"], stageOf);
    cap = await inferenceCapacity(QWEN3_0_6B);
    expect(cap.available).toBe(true);
    expect(cap.verifiable).toBe(false);
    expect(cap.readyNodes).toBe(5);

    // F becomes ready and connects: every stage has two.
    await reportShard(node("F"), { state: "ready" });
    present(QWEN3_0_6B.id, ids, stageOf);
    cap = await inferenceCapacity(QWEN3_0_6B);
    expect(cap.verifiable).toBe(true);
    expect((await pickModel())?.model.id).toBe(QWEN3_0_6B.id);

    // A silent node does not count even if the relay still lists it.
    await store().saveNode(node("C", { lastHeartbeatAt: Date.now() - 10 * 60_000 }));
    cap = await inferenceCapacity(QWEN3_0_6B);
    expect(cap.readyNodes).toBe(5);
    expect(cap.verifiable).toBe(false);
    // A node the relay does not see is not serving, whatever the DB says: stage 2 is now empty.
    present(QWEN3_0_6B.id, ["A", "B", "D", "E"], stageOf);
    cap = await inferenceCapacity(QWEN3_0_6B);
    expect(cap.available).toBe(false);
    expect(await pickModel()).toBeNull();
  });
});

describe("prompt-lookup drafting", () => {
  it("proposes what followed the last n-gram earlier in the context, newest match first", () => {
    //            0  1  2  3  4  5  6  7  8
    const ctx = [5, 6, 7, 8, 9, 5, 6, 7, 1, 5, 6];
    expect(lookupDrafts(ctx, 4)).toEqual([7, 1, 5, 6]);
    expect(lookupDrafts(ctx, 2)).toEqual([7, 1]);
    expect(lookupDrafts([1, 2, 3, 4], 4)).toEqual([]);
    expect(lookupDrafts([1, 2, 1, 2], 4)).toEqual([1, 2]);
    expect(lookupDrafts([], 4)).toEqual([]);
  });
});

describe("settlement", () => {
  const M = QWEN3_1_7B;
  const plan = stagePlan(M);
  const session = (nodes: InferenceSession["nodes"]): InferenceSession => ({
    id: "is-1",
    model: M.id,
    status: "completed",
    createdAt: Date.now() - 5_000,
    updatedAt: Date.now(),
    promptTokens: 20,
    outputTokens: 10,
    draftedTokens: 3,
    laps: 8,
    stages: plan.map((s) => ({ stage: s.stage, layerFrom: s.layerFrom, layerTo: s.layerTo, nodes: [["A", "B"], ["C"], ["D", "E"], ["F", "G"]][s.stage] })),
    nodes,
    finishReason: "stop",
    totalMs: 5_000,
    firstTokenMs: 800,
    provenance: "live",
  });
  const sn = (nodeId: string, stage: number, p: Partial<InferenceSession["nodes"][string]> = {}) => ({ nodeId, stage, hops: 8, tokens: 30, checked: 8, mismatches: 0, gpuMs: 300, ms: 900, ...p });

  beforeEach(async () => {
    g.__brainStore = new MemoryStore();
    for (const id of "ABCDEFG") await store().saveNode(node(id));
  });

  it("credits only fully replica-checked, agreeing nodes; unchecked work is recorded but earns nothing; disputes fail without attribution", async () => {
    const s = session({
      A: sn("A", 0),
      B: sn("B", 0),
      C: sn("C", 1, { checked: 0 }),
      D: sn("D", 2, { mismatches: 1 }),
      E: sn("E", 2, { mismatches: 1 }),
      F: sn("F", 3),
      G: sn("G", 3),
    });
    const sum = await settleSession(M, s);
    const u = plan.map((p) => stageUnits(M.config, p, 30));
    expect(sum.units).toEqual({ total: 2 * u[0] + u[1] + 2 * u[2] + 2 * u[3], verified: 2 * u[0] + 2 * u[3] });
    // The head stage does more work per token than a middle stage of the same depth would: the output projection.
    expect(u[3]).toBeGreaterThan(u[0]);
    expect(sum.verified).toBe(false);
    expect(sum.verification).toBe("unverified");
    expect(sum.stages[0].nodes.map((n) => n.verified)).toEqual([true, true]);
    expect(sum.stages[1].nodes.map((n) => n.verified)).toEqual([null]);
    expect(sum.stages[2].nodes.map((n) => n.verified)).toEqual([false, false]);

    const a = (await store().getNode("A"))!;
    const c = (await store().getNode("C"))!;
    const d = (await store().getNode("D"))!;
    expect(a.verifiedComputeUnits).toBe(u[0]);
    expect(a.verifiedJobs).toBe(1);
    expect(c.verifiedComputeUnits).toBe(0);
    expect(c.verifiedJobs + c.failedJobs).toBe(0);
    expect(d.verifiedComputeUnits).toBe(0);
    expect(d.failedJobs).toBe(0);

    const jobs = await store().listJobsForNode("C", 5);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "inference", status: "completed", verified: false, failReason: "no-replica", computeUnits: u[1] });
    expect((await store().listJobsForNode("D", 5))[0]).toMatchObject({ status: "failed", failReason: "replica-dispute" });
    expect((await store().listJobsForNode("A", 5))[0]).toMatchObject({ status: "completed", verified: true, spec: { kernel: "llm_stage", model: M.id, layerFrom: 0, layerTo: plan[0].layerTo, tokens: 30 } });
  });

  it("a fully verified session reports replica-tolerance and a decode rate; a dropped node that did nothing gets no row", async () => {
    const s = session({
      A: sn("A", 0),
      B: sn("B", 0),
      C: sn("C", 1),
      D: sn("D", 2),
      E: sn("E", 2, { hops: 0, tokens: 0, checked: 0, gpuMs: 0, ms: 0, dropped: "timeout" }),
      F: sn("F", 3),
      G: sn("G", 3),
    });
    const sum = await settleSession(M, s);
    expect(sum.verified).toBe(true);
    expect(sum.verification).toBe("replica-tolerance");
    expect(sum.tokPerSec).toBeCloseTo((9 * 1000) / 4200, 1);
    expect(sum.draftedTokens).toBe(3);
    expect(await store().listJobsForNode("E", 5)).toHaveLength(0);
    expect(sum.stages[2].nodes[1]).toMatchObject({ id: "E", hops: 0, verified: null, dropped: "timeout" });
  });
});
