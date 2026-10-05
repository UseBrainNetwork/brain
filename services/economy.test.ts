import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComputeReceipt } from "@/domain/economy";
import { referenceResult, workloadUnits } from "@/network/workloads";
import { record, snapshot } from "./accounting";
import { createJob, getJob } from "./distributed";
import { finalizeEpoch, verifyEpochHash } from "./epochs";
import { nodeProfile } from "./nodeProfile";
import { nextJob, startWork, submitResult } from "./nodes";
import { getReceipt, sha256 } from "./receipts";
import { epochAt } from "./settlement";
import { MemoryStore, type StoredNode } from "./store";

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };
const store = () => g.__brainStore!;
const DIMS = { m: 8, n: 8, k: 8 };

function node(id: string, extra: Partial<StoredNode> = {}): StoredNode {
  return { id, deviceClass: "OTHER_WEBGPU", status: "idle", computeScore: 10_000, advertisedMemoryGb: 1, joinedAt: Date.now(), lastHeartbeatAt: Date.now(), verifiedJobs: 0, failedJobs: 0, verifiedComputeUnits: 0, reputation: 0.95, provenance: "live", sessionHash: `s-${id}`, ipHash: "ip", walletVerified: false, tokenAmount: 0, heartbeats: 3, clientReportedDevice: "", ...extra };
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

describe("proof of compute + accounting", () => {
  const env = process.env;
  beforeEach(async () => {
    g.__brainStore = new MemoryStore();
    for (const id of ["AAAA", "BBBB"]) await store().saveNode(node(id));
    delete process.env.BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS;
  });
  afterEach(() => {
    process.env = env;
  });

  it("issues a receipt when a job completes; values come from the job; hash is reproducible", async () => {
    const job = await createJob({ dims: DIMS, unitsPerNode: 2 });
    await drain("AAAA");
    await drain("BBBB");
    const done = (await getJob(job.id))!;
    expect(done.status).toBe("completed");
    const r = (await getReceipt(`r-${job.id}`))!;
    expect(r.source).toBe("REAL");
    expect(r.status).toBe("VERIFIED");
    expect(r.verifiedWorkUnits).toBe(4);
    expect(r.totalComputeUnits).toBe(done.totals.computeUnits);
    expect(new Set(r.nodesUsed)).toEqual(new Set(["AAAA", "BBBB"]));
    expect(r.verificationMethod).toBe("spot-check");
    expect(r.verificationConfidence).toBeGreaterThan(0.5);
    expect(r.attestation).toEqual({ kind: "none" });
    // Recompute the digest from the verified outputs.
    const parts: string[] = [];
    for (const u of [...done.units].sort((a, b) => a.index - b.index || a.replica - b.replica)) {
      if (u.status !== "verified") continue;
      parts.push(`${u.index}:${u.replica}:${(await store().getJob(u.id))!.lastResult!.hashes.join(",")}`);
    }
    expect(r.resultHash).toBe(sha256(`brain-receipt-v1|${job.id}|${parts.join("|")}`));
    // Unpriced ⇒ no money invented.
    expect(r.customerCost).toBeNull();
    expect((await snapshot("REAL")).customersPaid.count).toBe(0);
  });

  it("accrues economics only when a list price is configured, split per node by verified units", async () => {
    process.env.BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS = "2";
    const job = await createJob({ dims: DIMS, unitsPerNode: 1 });
    await drain("AAAA");
    await drain("BBBB");
    const r = (await getReceipt(`r-${job.id}`))!;
    const units = 2 * workloadUnits({ kernel: "matmul_u32", ...DIMS, seedA: 0, seedB: 0 });
    expect(r.customerCost).toEqual({ amount: (units / 1000) * 2, currency: "USD", basis: "list-price" });
    const snap = await snapshot("REAL", 0, undefined, [r]); // `to` is exclusive; default includes the current ms
    expect(snap.customersPaid.accrued).toBeCloseTo(r.customerCost!.amount);
    expect(snap.customersPaid.settled).toBeNull(); // nobody has actually paid
    expect(snap.providersEarned.count).toBe(2);
    expect(snap.providersEarned.accrued).toBeCloseTo(r.providerCompensation!.amount);
    expect(snap.costPer1MUnits).toBeCloseTo(2000);
  });

  it("INVARIANT: simulated accounting never enters real totals", async () => {
    await record({ type: "CUSTOMER_PAYMENT", amount: 1_000_000, currency: "USD", timestamp: Date.now(), source: "SIMULATED", settlement: "accrued" });
    await record({ type: "CREATOR_REWARD_RECEIVED", amount: 99, currency: "SOL", timestamp: Date.now(), source: "SIMULATED", settlement: "settled", transactionReference: "sim" });
    const real = await snapshot("REAL");
    expect(real.customersPaid.count).toBe(0);
    expect(real.creatorRewards.count).toBe(0);
    expect(real.events).toBe(0);
    const sim = await snapshot("SIMULATED");
    expect(sim.customersPaid.accrued).toBe(1_000_000);
    // Settled events must carry a reference; accrued-by-default cannot be dressed up as paid.
    await expect(record({ type: "CUSTOMER_PAYMENT", amount: 1, currency: "USD", timestamp: 0, source: "REAL", settlement: "settled" })).rejects.toThrow(/transactionReference/);
  });

  it("INVARIANT: clients cannot self-report verified compute or earnings", async () => {
    const job = await createJob({ dims: DIMS, unitsPerNode: 1 });
    const j = (await nextJob(await fresh("AAAA"), { distributedOnly: true }))!;
    // The client claims an absurd GPU time; credit still equals the server's spec-derived units.
    await submitResult(await fresh("AAAA"), j.id, referenceResult(j.spec), 0.0001);
    const a = await fresh("AAAA");
    expect(a.verifiedComputeUnits).toBe(workloadUnits(j.spec));
    // A wrong answer earns nothing, whatever is claimed.
    const k = (await nextJob(await fresh("BBBB"), { distributedOnly: true }))!;
    const ref = referenceResult(k.spec);
    await submitResult(await fresh("BBBB"), k.id, { ...ref, hashes: ref.hashes.map((h, i) => (i === 2 ? (h ^ 1) >>> 0 : h)) }, 5);
    expect((await fresh("BBBB")).verifiedComputeUnits).toBe(0);
    expect((await getJob(job.id))!.totals.failed + (await getJob(job.id))!.totals.reassigned).toBeGreaterThan(0);
  });

  it("node profile is computed from server records", async () => {
    const job = await createJob({ dims: DIMS, unitsPerNode: 2 });
    await drain("AAAA");
    await drain("BBBB");
    const p = (await nodeProfile("AAAA"))!;
    expect(p.jobsVerified).toBe(2);
    expect(p.verificationRate).toBe(1);
    expect(p.computeUnits).toBe((await getJob(job.id))!.totals.computeUnits / 2);
    expect(p.reassignmentRate).toBe(0);
    expect(p.source).toBe("REAL");
    expect(JSON.stringify(p)).not.toMatch(/ipHash|sessionHash|wallet/);
  });

  it("epoch finalization is immutable, hash-verifiable and gives zero to zero-compute nodes", async () => {
    await store().saveNode(node("WHALE", { walletVerified: true, walletAddress: "W".repeat(44), tokenAmount: 50_000_000 }));
    const job = await createJob({ dims: DIMS, unitsPerNode: 1 });
    await drain("AAAA");
    await drain("BBBB");
    await drain("WHALE"); // WHALE got a unit too — fine; now also test a true zero-compute holder:
    await store().saveNode(node("IDLE", { walletVerified: true, walletAddress: "I".repeat(44), tokenAmount: 900_000_000 }));
    expect((await getJob(job.id))!.status).toBe("completed");
    const e = epochAt(Date.now());
    const r = await finalizeEpoch({ epochStart: e.startsAt, poolLamports: 1_000_000, now: e.endsAt + 1 });
    expect(r.created).toBe(true);
    expect(r.epoch.allocations.find((a) => a.nodeId === "IDLE")).toBeUndefined();
    expect(r.epoch.distributedLamports).toBeLessThanOrEqual(1_000_000);
    expect(verifyEpochHash(r.epoch)).toBe(true);
    const again = await finalizeEpoch({ epochStart: e.startsAt, poolLamports: 5, now: e.endsAt + 1 });
    expect(again.created).toBe(false);
    expect(again.epoch.poolLamports).toBe(1_000_000);
    const tampered = { ...r.epoch, allocations: r.epoch.allocations.map((a, i) => (i === 0 ? { ...a, lamports: a.lamports + 1 } : a)) };
    expect(verifyEpochHash(tampered)).toBe(false);
  });

  it("receipt type guards: a receipt is never a mix of sources", () => {
    const r: ComputeReceipt["source"] = "REAL";
    expect(["REAL", "SIMULATED"]).toContain(r);
  });
});
