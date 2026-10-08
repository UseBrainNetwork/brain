import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { referenceResult } from "@/network/workloads";
import { createJob, getJob } from "./distributed";
import { StoreConflictError } from "./failsoft";
import { nextJob, startWork, submitResult } from "./nodes";
import { MemoryStore, type StoredNode } from "./store";

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };
const store = () => g.__brainStore!;
const DIMS = { m: 8, n: 8, k: 8 };
const IDS = ["A1", "B2", "C3", "D4", "E5", "F6", "G7", "H8"];

function node(id: string): StoredNode {
  return { id, deviceClass: "OTHER_WEBGPU", status: "idle", computeScore: 10_000, advertisedMemoryGb: 1, joinedAt: Date.now(), lastHeartbeatAt: Date.now(), verifiedJobs: 0, failedJobs: 0, verifiedComputeUnits: 0, reputation: 0.95, provenance: "live", sessionHash: `s-${id}`, ipHash: "ip", walletVerified: false, tokenAmount: 0, heartbeats: 3, clientReportedDevice: "" };
}
const fresh = async (id: string) => (await store().getNode(id))!;

/**
 * Production runs on many serverless instances: the advisory lock serialises the ones that acquire
 * it, but an instance that cannot wait proceeds with only its in-process lock. Model that here by
 * making the store's lock a no-op, so every unit result races on the parent document.
 */
class UnlockedStore extends MemoryStore {
  override withLock<T>(_key: string, fn: () => Promise<T>) {
    return fn();
  }
}

describe("distributed job parent updates under concurrency", () => {
  beforeEach(async () => {
    g.__brainStore = new UnlockedStore();
    for (const id of IDS) await store().saveNode(node(id));
  });

  it("refuses to save a parent copy that is older than the stored one", async () => {
    const job = await createJob({ dims: DIMS, unitsPerNode: 1, scheduled: { by: "operator", reason: "test" } });
    const a = (await store().getDistributedJob(job.id))!;
    const b = (await store().getDistributedJob(job.id))!;
    await store().saveDistributedJob(a);
    await expect(store().saveDistributedJob(b)).rejects.toBeInstanceOf(StoreConflictError);
    expect(a.rev).toBe((job.rev ?? 0) + 1);
  });

  it("every unit returned at once is recorded and the job completes, with no lock at all", async () => {
    const job = await createJob({ dims: DIMS, unitsPerNode: 1, scheduled: { by: "operator", reason: "test" } });
    expect(job.units).toHaveLength(IDS.length);
    // Each node picks up its unit, then all submit in the same tick.
    const picked = await Promise.all(IDS.map(async (id) => ({ id, j: (await nextJob(await fresh(id), { distributedOnly: true }))! })));
    for (const { id, j } of picked) await startWork(await fresh(id), j.id);
    await Promise.all(picked.map(async ({ id, j }) => submitResult(await fresh(id), j.id, referenceResult(j.spec), 5)));

    const done = (await getJob(job.id))!;
    expect(done.units.map((u) => u.status)).toEqual(IDS.map(() => "verified"));
    expect(done.status).toBe("completed");
    expect(done.totals.verified).toBe(IDS.length);
  });
});
