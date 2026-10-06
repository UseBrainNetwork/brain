import { beforeEach, describe, expect, it } from "vitest";
import { SMOLLM2_135M, stageUnits } from "@/inference/config";
import { encodeF32 } from "@/inference/codec";
import { assignShard, inferenceCapacity, nextHop, reportShard, settleSession, submitHop, type Hop, type InferenceSession } from "./inference";
import { MemoryStore, type StoredNode } from "./store";

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };
const store = () => g.__brainStore!;

function node(id: string, extra: Partial<StoredNode> = {}): StoredNode {
  return {
    id,
    deviceClass: "OTHER_WEBGPU",
    status: "idle",
    computeScore: 10_000,
    advertisedMemoryGb: 1,
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

const H = SMOLLM2_135M.config.hidden;

describe("shard assignment and capacity", () => {
  beforeEach(async () => {
    g.__brainStore = new MemoryStore();
    for (const id of ["A", "B", "C", "D", "E", "F", "G"]) await store().saveNode(node(id));
  });

  it("spreads nodes over the stages with the fewest holders, and keeps a node on its stage", async () => {
    const stages: number[] = [];
    for (const id of ["A", "B", "C", "D"]) stages.push((await assignShard(node(id))).span.stage);
    expect(stages).toEqual([0, 1, 2, 0]);
    expect((await assignShard(node("B"))).span.stage).toBe(1);
    const cap = await inferenceCapacity();
    expect(cap.available).toBe(false);
    expect(cap.stages.map((s) => s.loading)).toEqual([2, 1, 1]);
  });

  it("is available once every stage has a ready node and verifiable with two each; offline nodes do not count", async () => {
    for (const id of ["A", "B", "C", "D", "E", "F"]) {
      await assignShard(node(id));
      await reportShard(node(id), { state: "ready" });
    }
    let cap = await inferenceCapacity();
    expect(cap.available && cap.verifiable).toBe(true);
    expect(cap.readyNodes).toBe(6);
    await store().saveNode(node("F", { status: "offline" }));
    cap = await inferenceCapacity();
    expect(cap.available).toBe(true);
    expect(cap.verifiable).toBe(false);
    await store().saveNode(node("C", { lastHeartbeatAt: Date.now() - 10 * 60_000 }));
    cap = await inferenceCapacity();
    expect(cap.available).toBe(false);
  });
});

describe("hops", () => {
  const hop = (id: string, nodeId: string, seq = 1, extra: Partial<Hop> = {}): Hop => ({
    id,
    sessionId: "is-1",
    model: SMOLLM2_135M.id,
    stage: 0,
    nodeId,
    step: 1,
    seq,
    positions: [7],
    cacheLen: 7,
    input: encodeF32(new Float32Array(seq * H)),
    status: "assigned",
    issuedAt: Date.now(),
    deadline: Date.now() + 5_000,
    ...extra,
  });

  beforeEach(async () => {
    g.__brainStore = new MemoryStore();
    for (const id of ["A", "B"]) {
      await store().saveNode(node(id));
      await assignShard(node(id));
    }
    await reportShard(node("A"), { state: "ready" });
  });

  it("a node without a ready shard gets nothing; a ready node gets its oldest open hop and idle polls return fast", async () => {
    expect(await nextHop(node("B"), 0)).toMatchObject({ hop: null, retryMs: 5_000 });
    const idle = await nextHop(node("A"), 0);
    expect(idle.hop).toBeNull();
    expect(idle.active).toBe(false);
    await store().putDoc("hop", "h2", hop("h2", "A", 1, { step: 2 }), { at: Date.now(), key: "A" });
    await store().putDoc("hop", "h1", hop("h1", "A"), { at: Date.now(), key: "A" });
    const r = await nextHop(node("A"), 0);
    expect(r.hop?.id).toBe("h1");
    // Nobody else's hop is visible.
    expect((await nextHop(node("B"), 0)).hop).toBeNull();
  });

  it("results are validated: owner, open status, exact payload size, deadline", async () => {
    await store().putDoc("hop", "h1", hop("h1", "A", 2), { at: Date.now(), key: "A" });
    await expect(submitHop(node("B"), "h1", { output: encodeF32(new Float32Array(2 * H)) })).rejects.toMatchObject({ code: "unknown_hop" });
    expect(await submitHop(node("A"), "h1", { output: encodeF32(new Float32Array(H)) })).toEqual({ ok: false });
    expect((await store().getDoc<Hop>("hop", "h1"))?.error).toMatch(/malformed/);
    await expect(submitHop(node("A"), "h1", { output: encodeF32(new Float32Array(2 * H)) })).rejects.toMatchObject({ code: "hop_closed" });

    await store().putDoc("hop", "h2", hop("h2", "A", 1), { at: Date.now(), key: "A" });
    expect(await submitHop(node("A"), "h2", { output: encodeF32(new Float32Array(H)), gpuMs: 12 })).toEqual({ ok: true });
    expect((await store().getDoc<Hop>("hop", "h2"))?.status).toBe("done");

    await store().putDoc("hop", "h3", hop("h3", "A", 1, { deadline: Date.now() - 1 }), { at: Date.now(), key: "A" });
    expect(await submitHop(node("A"), "h3", { output: encodeF32(new Float32Array(H)) })).toEqual({ ok: false });
    expect((await store().getDoc<Hop>("hop", "h3"))?.error).toBe("deadline");

    await store().putDoc("hop", "h4", hop("h4", "A", 1), { at: Date.now(), key: "A" });
    expect(await submitHop(node("A"), "h4", { error: "cache_mismatch:3" })).toEqual({ ok: false });
  });
});

describe("settlement", () => {
  const session = (nodes: InferenceSession["nodes"]): InferenceSession => ({
    id: "is-1",
    model: SMOLLM2_135M.id,
    status: "completed",
    createdAt: Date.now() - 5_000,
    updatedAt: Date.now(),
    promptTokens: 20,
    outputTokens: 10,
    stages: [
      { stage: 0, layerFrom: 0, layerTo: 10, nodes: ["A", "B"] },
      { stage: 1, layerFrom: 10, layerTo: 20, nodes: ["C"] },
      { stage: 2, layerFrom: 20, layerTo: 30, nodes: ["D", "E"] },
    ],
    nodes,
    finishReason: "stop",
    totalMs: 5_000,
    firstTokenMs: 800,
    provenance: "live",
  });

  beforeEach(async () => {
    g.__brainStore = new MemoryStore();
    for (const id of ["A", "B", "C", "D", "E"]) await store().saveNode(node(id));
  });

  it("credits only fully replica-checked, agreeing nodes; unchecked work is recorded but earns nothing; disputes fail without attribution", async () => {
    const s = session({
      A: { nodeId: "A", stage: 0, hops: 11, tokens: 30, checked: 11, mismatches: 0, gpuMs: 300 },
      B: { nodeId: "B", stage: 0, hops: 11, tokens: 30, checked: 11, mismatches: 0, gpuMs: 280 },
      C: { nodeId: "C", stage: 1, hops: 11, tokens: 30, checked: 0, mismatches: 0, gpuMs: 290 },
      D: { nodeId: "D", stage: 2, hops: 11, tokens: 30, checked: 11, mismatches: 1, gpuMs: 300 },
      E: { nodeId: "E", stage: 2, hops: 11, tokens: 30, checked: 11, mismatches: 1, gpuMs: 300 },
    });
    const sum = await settleSession(SMOLLM2_135M, s);
    const units = stageUnits(SMOLLM2_135M.config, 10, 30);
    expect(sum.units).toEqual({ total: units * 5, verified: units * 2 });
    expect(sum.verified).toBe(false);
    expect(sum.verification).toBe("unverified");
    expect(sum.stages[0].nodes.map((n) => n.verified)).toEqual([true, true]);
    expect(sum.stages[1].nodes.map((n) => n.verified)).toEqual([null]);
    expect(sum.stages[2].nodes.map((n) => n.verified)).toEqual([false, false]);

    const a = (await store().getNode("A"))!;
    const c = (await store().getNode("C"))!;
    const d = (await store().getNode("D"))!;
    expect(a.verifiedComputeUnits).toBe(units);
    expect(a.verifiedJobs).toBe(1);
    expect(c.verifiedComputeUnits).toBe(0);
    expect(c.verifiedJobs + c.failedJobs).toBe(0);
    expect(d.verifiedComputeUnits).toBe(0);
    expect(d.failedJobs).toBe(0);

    const jobs = await store().listJobsForNode("C", 5);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "inference", status: "completed", verified: false, failReason: "no-replica", computeUnits: units });
    expect((await store().listJobsForNode("D", 5))[0]).toMatchObject({ status: "failed", failReason: "replica-dispute" });
    expect((await store().listJobsForNode("A", 5))[0]).toMatchObject({ status: "completed", verified: true, spec: { kernel: "llm_stage", layerFrom: 0, layerTo: 10, tokens: 30 } });
  });

  it("a fully verified session reports replica-tolerance and a decode rate", async () => {
    const s = session({
      A: { nodeId: "A", stage: 0, hops: 11, tokens: 30, checked: 11, mismatches: 0, gpuMs: 300 },
      B: { nodeId: "B", stage: 0, hops: 11, tokens: 30, checked: 11, mismatches: 0, gpuMs: 280 },
      C: { nodeId: "C", stage: 1, hops: 11, tokens: 30, checked: 11, mismatches: 0, gpuMs: 290 },
      D: { nodeId: "D", stage: 2, hops: 11, tokens: 30, checked: 11, mismatches: 0, gpuMs: 300 },
      E: { nodeId: "E", stage: 2, hops: 0, tokens: 0, checked: 0, mismatches: 0, gpuMs: 0, dropped: "deadline" },
    });
    const sum = await settleSession(SMOLLM2_135M, s);
    expect(sum.verified).toBe(true);
    expect(sum.verification).toBe("replica-tolerance");
    expect(sum.tokPerSec).toBeCloseTo((9 * 1000) / 4200, 1);
    // The dropped node did no work: no job row, no verdict.
    expect(await store().listJobsForNode("E", 5)).toHaveLength(0);
    expect(sum.stages[2].nodes[1]).toMatchObject({ id: "E", hops: 0, verified: null, dropped: "deadline" });
  });
});
