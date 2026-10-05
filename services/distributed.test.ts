import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NetworkEvent } from "@/domain/types";
import { referenceResult, workloadUnits } from "@/network/workloads";
import { createJob, getJob } from "./distributed";
import { eventBus } from "./eventBus";
import { leave, nextJob, startWork, submitResult } from "./nodes";
import { MemoryStore, type StoredNode } from "./store";

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };
const store = () => g.__brainStore!;
const DIMS = { m: 8, n: 8, k: 8 };

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

const fresh = async (id: string) => (await store().getNode(id))!;

/** Drain a node: fetch and correctly answer every unit assigned to it. */
async function work(id: string, opts: { wrong?: boolean; max?: number } = {}) {
  let done = 0;
  while (done < (opts.max ?? 99)) {
    const j = await nextJob(await fresh(id), { distributedOnly: true });
    if (!j) break;
    await startWork(await fresh(id), j.id);
    const ref = referenceResult(j.spec);
    const result = opts.wrong ? { ...ref, hashes: ref.hashes.map((h, i) => (i === 3 ? (h ^ 1) >>> 0 : h)) } : ref;
    await submitResult(await fresh(id), j.id, result, 5);
    done++;
  }
  return done;
}

describe("distributed jobs", () => {
  let events: NetworkEvent[];
  let unsub = () => {};
  afterEach(() => unsub());
  beforeEach(async () => {
    g.__brainStore = new MemoryStore();
    events = [];
    unsub = eventBus.subscribe((e) => events.push(e));
    for (const id of ["AAAA", "BBBB", "CCCC"]) await store().saveNode(node(id));
  });

  it("refuses without real nodes and while one is in flight", async () => {
    for (const id of ["AAAA", "BBBB", "CCCC"]) await store().saveNode(node(id, { status: "offline" }));
    await expect(createJob({ dims: DIMS })).rejects.toMatchObject({ code: "no_real_nodes" });
    await store().saveNode(node("AAAA"));
    await createJob({ dims: DIMS, unitsPerNode: 1 });
    await expect(createJob({ dims: DIMS })).rejects.toMatchObject({ code: "job_in_progress" });
  });

  it("splits round-robin across live nodes and completes once every unit verifies", async () => {
    const job = await createJob({ dims: DIMS, unitsPerNode: 2 });
    expect(job.status).toBe("distributed");
    expect(job.units).toHaveLength(6);
    expect(new Set(job.units.map((u) => u.nodeId))).toEqual(new Set(["AAAA", "BBBB", "CCCC"]));
    expect(job.units.map((u) => u.label)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect((await fresh("AAAA")).status).toBe("computing");

    expect(await work("AAAA")).toBe(2);
    expect((await getJob(job.id))!.status).toBe("verifying");
    expect(await work("BBBB")).toBe(2);
    expect(await work("CCCC")).toBe(2);

    const done = (await getJob(job.id))!;
    expect(done.status).toBe("completed");
    expect(done.totals).toMatchObject({ workUnits: 6, verified: 6, failed: 0, reassigned: 0, nodesUsed: 3 });
    expect(done.totals.computeUnits).toBe(6 * workloadUnits({ kernel: "matmul_u32", ...DIMS, seedA: 0, seedB: 0 }));
    expect(done.totals.latencyMs).toBeGreaterThanOrEqual(0);
    expect(done.units.every((u) => u.verification?.method === "spot-check" && u.verification.confidence > 0.8)).toBe(true);
    // Server-authoritative credit: the node's counter equals the spec-derived units, not anything it sent.
    expect((await fresh("AAAA")).verifiedComputeUnits).toBe(2 * workloadUnits({ kernel: "matmul_u32", ...DIMS, seedA: 0, seedB: 0 }));
    expect((await fresh("AAAA")).status).toBe("idle");
    const types = events.map((e) => e.type);
    for (const t of ["djob.created", "djob.assigned", "work.started", "work.completed", "work.verified", "djob.completed"]) expect(types).toContain(t);
  });

  it("flags a wrong answer as MISMATCH and reassigns the slot to another node", async () => {
    const job = await createJob({ dims: DIMS, unitsPerNode: 1 });
    expect(await work("AAAA", { wrong: true })).toBe(1);
    let j = (await getJob(job.id))!;
    const bad = j.units.find((u) => u.nodeId === "AAAA" && u.status === "mismatch")!;
    expect(bad.verification?.reason).toMatch(/mismatch/);
    const retry = j.units.find((u) => u.replacedUnitId === bad.id)!;
    expect(retry.attempt).toBe(2);
    expect(retry.nodeId).not.toBe("AAAA");
    expect(events.some((e) => e.type === "work.reassigned" && e.fromNodeId === "AAAA")).toBe(true);

    for (const id of ["AAAA", "BBBB", "CCCC"]) await work(id);
    j = (await getJob(job.id))!;
    expect(j.status).toBe("completed");
    expect(j.totals).toMatchObject({ workUnits: 3, verified: 3, failed: 1, reassigned: 1 });
    expect((await fresh("AAAA")).failedJobs).toBe(1);
  });

  it("reassigns the work of a node that leaves mid-job and still completes", async () => {
    const job = await createJob({ dims: DIMS, unitsPerNode: 2 });
    await leave(await fresh("CCCC"));
    const j = (await getJob(job.id))!;
    expect(j.units.filter((u) => u.status === "lost")).toHaveLength(2);
    const moved = j.units.filter((u) => u.replacedUnitId);
    expect(moved).toHaveLength(2);
    expect(moved.every((u) => u.nodeId !== "CCCC")).toBe(true);
    expect(events.filter((e) => e.type === "work.reassigned")).toHaveLength(2);

    await work("AAAA");
    await work("BBBB");
    const done = (await getJob(job.id))!;
    expect(done.status).toBe("completed");
    expect(done.totals.verified).toBe(6);
    expect(done.totals.nodesUsed).toBe(2);
  });

  it("fails honestly when no node is left to take a lost unit", async () => {
    for (const id of ["BBBB", "CCCC"]) await store().saveNode(node(id, { status: "offline" }));
    const job = await createJob({ dims: DIMS, unitsPerNode: 1 });
    await leave(await fresh("AAAA"));
    const j = (await getJob(job.id))!;
    expect(j.status).toBe("failed");
    expect(events.some((e) => e.type === "djob.failed")).toBe(true);
  });

  it("redundancy 2 runs each unit on two nodes and cross-checks replicas", async () => {
    const job = await createJob({ dims: DIMS, unitsPerNode: 1, redundancy: 2 });
    expect(job.redundancy).toBe(2);
    expect(job.units).toHaveLength(6);
    for (let i = 0; i < 3; i++) {
      const pair = job.units.filter((u) => u.index === i);
      expect(new Set(pair.map((u) => u.nodeId)).size).toBe(2);
    }
    for (const id of ["AAAA", "BBBB", "CCCC"]) await work(id);
    const done = (await getJob(job.id))!;
    expect(done.status).toBe("completed");
    expect(done.units.filter((u) => u.verification?.method === "redundant+spot-check")).toHaveLength(3);
    expect(done.units.filter((u) => u.verification?.method === "spot-check")).toHaveLength(3);
  });

  it("a distributed-only node waits (null) when nothing is assigned", async () => {
    await store().saveNode(node("AAAA", { status: "computing" }));
    expect(await nextJob(await fresh("AAAA"), { distributedOnly: true })).toBeNull();
    expect((await fresh("AAAA")).status).toBe("idle");
  });
});
