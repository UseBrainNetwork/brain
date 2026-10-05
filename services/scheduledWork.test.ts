import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountingEvent } from "@/domain/economy";
import { referenceResult } from "@/network/workloads";
import { activeJob, createJob, getJob } from "./distributed";
import { nextJob, startWork, submitResult } from "./nodes";
import { getReceipt } from "./receipts";
import { ensureScheduledWork, pickSize } from "./scheduledWork";
import { MemoryStore, type StoredNode } from "./store";

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore; __brainSchedAt?: number; __brainScheduling?: boolean };
const store = () => g.__brainStore!;

function node(id: string): StoredNode {
  return { id, deviceClass: "OTHER_WEBGPU", status: "idle", computeScore: 10_000, advertisedMemoryGb: 1, joinedAt: Date.now(), lastHeartbeatAt: Date.now(), verifiedJobs: 0, failedJobs: 0, verifiedComputeUnits: 0, reputation: 0.95, provenance: "live", sessionHash: `s-${id}`, ipHash: "ip", walletVerified: false, tokenAmount: 0, heartbeats: 3, clientReportedDevice: "" };
}
const T = { dims: { m: 8, n: 8, k: 8 }, unitsPerNode: 1 };
const fresh = async (id: string) => (await store().getNode(id))!;

async function drain(id: string) {
  for (;;) {
    const j = await nextJob(await fresh(id), { distributedOnly: true });
    if (!j) return;
    await startWork(await fresh(id), j.id);
    await submitResult(await fresh(id), j.id, referenceResult(j.spec), 5);
  }
}

describe("scheduled work", () => {
  const env = process.env;
  beforeEach(async () => {
    g.__brainStore = new MemoryStore();
    g.__brainSchedAt = 0;
    g.__brainScheduling = false;
    for (const id of ["AAAA", "BBBB"]) await store().saveNode(node(id));
    process.env = { ...env, BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS: "1", BRAIN_SCHEDULED_WORK_GAP_MS: "0" };
    delete process.env.BRAIN_SCHEDULED_WORK;
    delete process.env.BRAIN_SCHEDULED_WORK_PER_HOUR;
  });
  afterEach(() => {
    process.env = env;
  });

  it("rotates sizes", () => {
    expect(pickSize(0.1)).toBe("small");
    expect(pickSize(0.5)).toBe("medium");
    expect(pickSize(0.9)).toBe("large");
  });

  it("dispatches one fleet-wide job, labeled, with no customer charge", async () => {
    const r = await ensureScheduledWork(Date.now(), T);
    expect(r.reason).toBe("dispatched");
    expect(r.job!.scheduled).toEqual({ by: "operator", reason: "network-baseline" });
    expect(r.job!.nodeIds.sort()).toEqual(["AAAA", "BBBB"]);
    // Does not occupy the interactive slot.
    expect(await activeJob()).toBeNull();

    // A second call while it is in flight does nothing (throttle reset to simulate a later poll).
    g.__brainSchedAt = 0;
    expect((await ensureScheduledWork(Date.now(), T)).reason).toBe("in flight");

    await drain("AAAA");
    await drain("BBBB");
    const job = (await getJob(r.job!.id))!;
    expect(job.status).toBe("completed");
    const receipt = (await getReceipt(`r-${job.id}`))!;
    expect(receipt.scheduled?.by).toBe("operator");
    expect(receipt.customerCost).toBeNull();
    expect(receipt.status).toBe("VERIFIED");
    const events = await store().listDocs<AccountingEvent>("accounting", { key: "REAL", limit: 100 });
    expect(events.filter((e) => e.type === "CUSTOMER_PAYMENT" && e.relatedJobId === job.id)).toHaveLength(0);
    expect(events.filter((e) => e.type === "PROTOCOL_REVENUE" && e.relatedJobId === job.id)).toHaveLength(0);
  });

  it("does not block, and is not blocked by, an interactive job", async () => {
    await createJob({ size: "small", ...T });
    g.__brainSchedAt = 0;
    expect((await ensureScheduledWork(Date.now(), T)).reason).toBe("dispatched");
  });

  it("respects the hourly cap and the off switch", async () => {
    process.env.BRAIN_SCHEDULED_WORK_PER_HOUR = "1";
    expect((await ensureScheduledWork(Date.now(), T)).reason).toBe("dispatched");
    await drain("AAAA");
    await drain("BBBB");
    g.__brainSchedAt = 0;
    expect((await ensureScheduledWork(Date.now(), T)).reason).toBe("hourly cap");
    process.env.BRAIN_SCHEDULED_WORK = "off";
    g.__brainSchedAt = 0;
    expect((await ensureScheduledWork(Date.now(), T)).reason).toBe("disabled");
  });

  it("is skipped, not faked, with no live nodes", async () => {
    g.__brainStore = new MemoryStore();
    expect((await ensureScheduledWork(Date.now(), T)).reason).toBe("no_real_nodes");
  });
});
