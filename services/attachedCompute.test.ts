import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComputeOrder } from "@/domain/economy";
import { referenceResult } from "@/network/workloads";
import type { AccountingEvent } from "@/domain/economy";
import { attachCompute, nodesFor, sizeFor } from "./attachedCompute";
import { activeJob, createJob, getJob } from "./distributed";
import { nextJob, startWork, submitResult } from "./nodes";
import { getReceipt } from "./receipts";
import { MemoryStore, type StoredNode } from "./store";

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };
const store = () => g.__brainStore!;

function node(id: string): StoredNode {
  return { id, deviceClass: "OTHER_WEBGPU", status: "idle", computeScore: 10_000, advertisedMemoryGb: 1, joinedAt: Date.now(), lastHeartbeatAt: Date.now(), verifiedJobs: 0, failedJobs: 0, verifiedComputeUnits: 0, reputation: 0.95, provenance: "live", sessionHash: `s-${id}`, ipHash: "ip", walletVerified: false, tokenAmount: 0, heartbeats: 3, clientReportedDevice: "" };
}
const fresh = async (id: string) => (await store().getNode(id))!;

async function drain(id: string) {
  for (;;) {
    const j = await nextJob(await fresh(id), { distributedOnly: true });
    if (!j) return;
    await startWork(await fresh(id), j.id);
    await submitResult(await fresh(id), j.id, referenceResult(j.spec), 5);
  }
}

const order = (id: string, status: ComputeOrder["status"] = "COMPLETED"): ComputeOrder =>
  ({ orderId: id, status, request: { kind: "chat", model: "test/model", messages: [{ role: "user", content: "hi" }] }, customerId: "c", createdAt: Date.now() }) as unknown as ComputeOrder;

describe("attached compute", () => {
  const env = process.env;
  beforeEach(async () => {
    g.__brainStore = new MemoryStore();
    for (const id of ["AAAA", "BBBB", "CCCC"]) await store().saveNode(node(id));
    process.env.BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS = "1";
    delete process.env.BRAIN_ATTACHED_COMPUTE;
  });
  afterEach(() => {
    process.env = env;
  });

  it("sizes by tokens and spreads thin", () => {
    expect(sizeFor(100)).toBe("small");
    expect(sizeFor(1000)).toBe("medium");
    expect(sizeFor(5000)).toBe("large");
    expect(nodesFor(100)).toBe(2);
    expect(nodesFor(5000)).toBe(8);
  });

  it("dispatches a labeled job for a completed chat order; several can be in flight; it never blocks interactive jobs", async () => {
    const a = await attachCompute(order("ord-1"), { inputUnits: 50, outputUnits: 50 });
    const b = await attachCompute(order("ord-2"), { inputUnits: 50, outputUnits: 50 });
    expect(a?.skipped).toBeUndefined();
    expect(b?.skipped).toBeUndefined();
    expect(a!.nodes).toBe(2);
    expect(a!.workUnits).toBe(2);
    const ja = (await getJob(a!.jobId))!;
    expect(ja.attachedTo?.orderId).toBe("ord-1");
    expect(ja.lifecycle[0].detail).toContain("attached to ord-1");
    // Attached jobs are not "the" active job, so the demo / routed path is still free.
    expect(await activeJob()).toBeNull();
    const interactive = await createJob({ dims: { m: 8, n: 8, k: 8 }, unitsPerNode: 1 });
    expect(interactive.attachedTo).toBeUndefined();
    expect((await activeJob())?.id).toBe(interactive.id);
    // ...but an interactive job in flight does not stop attached work from being dispatched.
    const c = await attachCompute(order("ord-3"), undefined);
    expect(c?.skipped).toBeUndefined();
  });

  it("does nothing for failed orders, non-chat orders, or when disabled", async () => {
    expect(await attachCompute(order("x", "FAILED"), undefined)).toBeNull();
    process.env.BRAIN_ATTACHED_COMPUTE = "off";
    expect(await attachCompute(order("y"), undefined)).toBeNull();
  });

  it("reports no_nodes when nobody is online instead of inventing work", async () => {
    g.__brainStore = new MemoryStore();
    const r = await attachCompute(order("z"), undefined);
    expect(r?.skipped).toBe("no_nodes");
    expect(r?.nodes).toBe(0);
  });

  it("completed attached job: receipt is labeled, no second customer charge, nodes still credited verified compute", async () => {
    const a = await attachCompute(order("ord-9"), { inputUnits: 10, outputUnits: 10 });
    const job = (await getJob(a!.jobId))!;
    for (const id of job.nodeIds) await drain(id);
    const done = (await getJob(job.id))!;
    expect(done.status).toBe("completed");
    const r = (await getReceipt(`r-${job.id}`))!;
    expect(r.attachedTo).toEqual({ orderId: "ord-9", model: "test/model" });
    expect(r.customerCost).toBeNull();
    expect(r.providerCompensation).toBeNull();
    expect(r.nodesUsed.length).toBe(2);
    expect(r.status).toBe("VERIFIED");
    // No CUSTOMER_PAYMENT was fabricated for the attached job.
    const events = await store().listDocs<AccountingEvent>("accounting", { key: "REAL", from: 0, to: Date.now() + 1, limit: 1000 });
    expect(events.filter((e) => e.relatedJobId === job.id && e.type === "CUSTOMER_PAYMENT")).toHaveLength(0);
    // Verified compute units landed on the nodes, which is what the hourly pool pays on.
    for (const id of done.nodeIds) expect((await fresh(id)).verifiedComputeUnits).toBeGreaterThan(0);
  });
});
