import { createHash } from "node:crypto";
import type { ComputeReceipt, Money } from "@/domain/economy";
import type { DistributedJob } from "@/domain/types";
import { priceForComputeUnits } from "@/lib/pricing";
import { defaultRevenueSplit } from "@/rewards/config";
import { accrueReceipt } from "./accounting";
import { eventBus } from "./eventBus";
import { getStore } from "./store";

/**
 * Proof of compute. A receipt is the permanent, public record of one job: what ran, on which
 * anonymous nodes, how it was verified, and what it cost (when priced).
 *
 * resultHash is sha256 over the ordered verified unit outputs. Anyone with those outputs can
 * recompute it; it binds the receipt to the data. It does NOT prove the computation happened on
 * the stated nodes — that assurance comes from the server-side verification method and
 * confidence recorded alongside. Signatures / anchoring are reserved in `attestation`.
 */

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function money(amount: number | null, basis: Money["basis"]): Money | null {
  return amount == null ? null : { amount, currency: "USD", basis };
}

export async function issueReceipt(job: DistributedJob): Promise<ComputeReceipt> {
  const store = getStore();
  const existing = await store.getDoc<ComputeReceipt>("receipt", `r-${job.id}`);
  if (existing) return existing;

  const verified = job.units.filter((u) => u.status === "verified").sort((a, b) => a.index - b.index || a.replica - b.replica);
  const parts: string[] = [];
  const nodeUnits: Record<string, number> = {};
  for (const u of verified) {
    const unitJob = await store.getJob(u.id);
    const hashes = unitJob?.lastResult?.hashes ?? [];
    parts.push(`${u.index}:${u.replica}:${hashes.join(",")}`);
    nodeUnits[u.nodeId] = (nodeUnits[u.nodeId] ?? 0) + u.computeUnits;
  }
  const confidences = verified.map((u) => u.verification?.confidence ?? 0);
  const t = job.totals;
  const completedAt = job.completedAt ?? Date.now();
  const customerCost = job.status === "completed" ? priceForComputeUnits(t.computeUnits) : null;
  const split = defaultRevenueSplit.inferenceRevenue;

  const receipt: ComputeReceipt = {
    receiptId: `r-${job.id}`,
    jobId: job.id,
    workloadType: "matmul_u32",
    model: "brain/matmul-u32",
    createdAt: job.createdAt,
    completedAt,
    nodesUsed: Object.keys(nodeUnits),
    workUnits: t.workUnits * job.redundancy,
    verifiedWorkUnits: t.verified,
    failedWorkUnits: t.failed,
    reassignedWorkUnits: t.reassigned,
    totalComputeUnits: t.computeUnits,
    executionTimeMs: t.latencyMs ?? completedAt - job.createdAt,
    verificationMethod: job.redundancy === 2 ? "redundant+spot-check" : "spot-check",
    verificationConfidence: confidences.length ? Math.min(...confidences) : 0,
    resultHash: sha256(`brain-receipt-v1|${job.id}|${parts.join("|")}`),
    resultHashLabel: "sha256 of verified unit outputs",
    attestation: { kind: "none" },
    source: "REAL",
    customerCost: money(customerCost, "list-price"),
    providerCompensation: money(customerCost == null ? null : customerCost * split.contributors, "list-price"),
    protocolRevenue: money(customerCost == null ? null : customerCost * (split.buyback + split.treasury), "list-price"),
    route: { target: "BROWSER_NETWORK", providerId: "brain-browser-pool", decisionId: job.decisionId },
    orderId: job.orderId,
    status: job.status === "completed" ? (t.failed > 0 || t.reassigned > 0 ? "PARTIAL" : "VERIFIED") : "FAILED",
  };
  await store.putDoc("receipt", receipt.receiptId, receipt, { at: receipt.completedAt, key: receipt.source });
  eventBus.publish({ type: "receipt.issued", at: completedAt, receipt });
  await accrueReceipt(receipt, nodeUnits);
  return receipt;
}

export async function getReceipt(id: string) {
  return getStore().getDoc<ComputeReceipt>("receipt", id);
}

export async function listReceipts(limit = 20) {
  return getStore().listDocs<ComputeReceipt>("receipt", { limit, key: "REAL" });
}

export async function receiptForJob(jobId: string) {
  return getReceipt(`r-${jobId}`);
}
