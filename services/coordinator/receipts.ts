import "server-only";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { CanonicalReceiptBody, ComputeReceipt, Money } from "@/domain/economy";
import { priceForTokens, tokenListPricePer1MUsd } from "@/lib/pricing";
import { defaultRevenueSplit } from "@/rewards/config";
import { accrueReceipt } from "@/services/accounting";
import { eventBus } from "@/services/eventBus";
import { serverSecret } from "@/services/security";
import { getStore } from "@/services/store";
import type { InferenceJob } from "./jobs";
import { getNativeNode } from "./registry";

/**
 * Brain Compute Receipts for native-node inference.
 *
 * Canonical serialisation: JSON with keys sorted recursively, no whitespace. Hash: sha256 of that
 * string. Signature: ed25519 by the coordinator over the hash bytes. Anyone holding the receipt can
 * recompute the hash from `canonical.body` and check the signature against the public key served
 * at /api/coordinator/signer. This is the unit that a later Solana program anchors in batches
 * (a Merkle root per epoch), keeping per-token traffic off-chain.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export const canonicalReceipt = (body: CanonicalReceiptBody) => canonicalJson(body);
export const receiptHash = (body: CanonicalReceiptBody) => createHash("sha256").update(canonicalReceipt(body)).digest("hex");

/* ---------------------------------------------------------------- signer */

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Coordinator signing key. `BRAIN_COORDINATOR_SIGNING_SEED` (base64, 32 bytes) when set; otherwise
 * derived from the server secret so a single-secret deployment still signs consistently. Rotating
 * either rotates the signer, which is why the public key travels with every receipt.
 */
function signerKeys() {
  const env = process.env.BRAIN_COORDINATOR_SIGNING_SEED;
  const seed = env ? Buffer.from(env, "base64") : createHash("sha256").update(Buffer.concat([Buffer.from("brain-coordinator-signer|"), serverSecret()])).digest();
  if (seed.length !== 32) throw new Error("BRAIN_COORDINATOR_SIGNING_SEED must be 32 bytes base64");
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
  return { priv, pubRaw: pub.subarray(pub.length - 32).toString("base64") };
}

const g = globalThis as typeof globalThis & { __brainSigner?: ReturnType<typeof signerKeys> };
const signer = () => (g.__brainSigner ??= signerKeys());

export const coordinatorPublicKey = () => signer().pubRaw;

export function signReceiptHash(hashHex: string): { signer: string; signature: string } {
  const { priv, pubRaw } = signer();
  return { signer: pubRaw, signature: sign(null, Buffer.from(hashHex, "hex"), priv).toString("base64") };
}

export function verifyReceiptSignature(hashHex: string, signerB64: string, signatureB64: string): boolean {
  try {
    const raw = Buffer.from(signerB64, "base64");
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(hashHex, "hex"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** Checks a receipt end to end: recomputed hash matches, signature verifies. */
export function verifyReceipt(r: ComputeReceipt): { ok: boolean; reason?: string } {
  if (!r.canonical) return { ok: false, reason: "no canonical body" };
  if (receiptHash(r.canonical.body) !== r.canonical.hash) return { ok: false, reason: "hash mismatch" };
  if (r.attestation.kind !== "signature") return { ok: false, reason: "unsigned" };
  return verifyReceiptSignature(r.canonical.hash, r.attestation.signer, r.attestation.signature) ? { ok: true } : { ok: false, reason: "bad signature" };
}

/* ---------------------------------------------------------------- issue */

const money = (amount: number | null, basis: Money["basis"]): Money | null => (amount == null ? null : { amount, currency: "USD", basis });

export async function issueNodeReceipt(j: InferenceJob, now = Date.now()): Promise<ComputeReceipt> {
  const store = getStore();
  const id = `r-${j.jobId}`;
  const existing = await store.getDoc<ComputeReceipt>("receipt", id);
  if (existing) return existing;
  const node = j.assignedNode ? await getNativeNode(j.assignedNode) : null;
  const usage = j.tokenUsage ?? { prompt: 0, completion: 0, basis: "node-reported" as const };
  const total = usage.prompt + usage.completion;
  // Customer price is the configured list price; null = UNKNOWN. Provider share follows the published split.
  const list = priceForTokens(total, tokenListPricePer1MUsd());
  const customerCost = money(list, "list-price");
  const providerCompensation = money(list == null ? null : list * defaultRevenueSplit.inferenceRevenue.contributors, "list-price");
  const protocolRevenue = money(list == null ? null : list * (defaultRevenueSplit.inferenceRevenue.buyback + defaultRevenueSplit.inferenceRevenue.treasury), "list-price");
  const body: CanonicalReceiptBody = {
    v: 1,
    jobId: j.jobId,
    nodeId: j.assignedNode ?? "",
    model: j.model,
    inputTokens: usage.prompt,
    outputTokens: usage.completion,
    executionMs: j.computeDurationMs ?? 0,
    timestamp: j.completedAt ?? now,
    requestHash: j.requestHash,
    responseHash: j.responseHash ?? "",
    hardwareClass: node?.benchmark.computeClass ?? (node?.reported.hardware.mock ? "MOCK" : "UNCLASSIFIED"),
    cost: customerCost ? { amount: customerCost.amount, currency: "USD" } : null,
  };
  const hash = receiptHash(body);
  const receipt: ComputeReceipt = {
    receiptId: id,
    jobId: j.jobId,
    workloadType: "chat",
    model: j.model,
    createdAt: j.createdAt,
    completedAt: body.timestamp,
    nodesUsed: j.assignedNode ? [j.assignedNode] : [],
    workUnits: 1,
    verifiedWorkUnits: 0,
    failedWorkUnits: 0,
    reassignedWorkUnits: Math.max(0, j.attempts - 1),
    totalComputeUnits: 0,
    executionTimeMs: j.computeDurationMs ?? 0,
    verificationMethod: "node-reported",
    verificationConfidence: 0,
    resultHash: body.responseHash,
    resultHashLabel: "sha256 of node response",
    attestation: { kind: "signature", ...signReceiptHash(hash) },
    canonical: { body, hash },
    source: "REAL",
    customerCost,
    providerCompensation,
    protocolRevenue,
    route: { target: "NATIVE_NETWORK", providerId: "brain-native-pool", ...(j.decisionId ? { decisionId: j.decisionId } : {}) },
    ...(j.orderId ? { orderId: j.orderId } : {}),
    tokens: { prompt: usage.prompt, completion: usage.completion, basis: "node-reported" },
    status: "VERIFIED",
  };
  await store.putDoc("receipt", id, receipt, { at: receipt.completedAt, key: receipt.source });
  eventBus.publish({ type: "receipt.issued", at: receipt.completedAt, receipt });
  // Accounting: the node earned the provider share of this receipt (accrued, unpaid). Weighted by output tokens.
  await accrueReceipt(receipt, j.assignedNode ? { [j.assignedNode]: Math.max(1, usage.completion) } : {}, { customerId: j.requesterId }).catch((e) => console.error("accrue node receipt", e));
  return receipt;
}
