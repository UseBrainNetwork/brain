import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalReceiptBody, ComputeReceipt } from "@/domain/economy";
import { MemoryStore } from "@/services/store";

vi.mock("server-only", () => ({}));

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };

const { createCustomer, recordRequest } = await import("@/services/customers");
const { receiptHash, signReceiptHash } = await import("@/services/coordinator/receipts");
const { GET } = await import("./route");
const { GET: VERIFY } = await import("../../receipts/[id]/verify/route");

function signedReceipt(id: string, at: number): ComputeReceipt {
  const body: CanonicalReceiptBody = { v: 1, jobId: id, nodeId: "N-ABCDEF01", model: "qwen/qwen2.5-1.5b-instruct", inputTokens: 10, outputTokens: 20, executionMs: 1000, timestamp: at, requestHash: "cd".repeat(32), responseHash: "ab".repeat(32), hardwareClass: "RTX_4090", cost: { amount: 0.001, currency: "USD" } };
  const hash = receiptHash(body);
  return {
    receiptId: `r-${id}`,
    jobId: id,
    workloadType: "chat",
    model: "qwen/qwen2.5-1.5b-instruct",
    createdAt: at - 1000,
    completedAt: at,
    nodesUsed: ["N-ABCDEF01"],
    workUnits: 1,
    verifiedWorkUnits: 1,
    failedWorkUnits: 0,
    reassignedWorkUnits: 0,
    totalComputeUnits: 10,
    executionTimeMs: 1000,
    verificationMethod: "node-reported",
    verificationConfidence: 0.3,
    resultHash: "ab".repeat(32),
    resultHashLabel: "sha256 of node response",
    attestation: { kind: "signature", ...signReceiptHash(hash) },
    canonical: { body, hash },
    source: "REAL",
    customerCost: { amount: 0.001, currency: "USD", basis: "list-price" },
    providerCompensation: null,
    protocolRevenue: null,
    route: { target: "NATIVE_NETWORK", providerId: "native" },
    status: "VERIFIED",
  };
}

const req = (url: string, key?: string) => new Request(url, { headers: key ? { authorization: `Bearer ${key}`, "x-forwarded-for": "10.0.0.1" } : { "x-forwarded-for": "10.0.0.1" } });

describe("GET /v1/receipts", () => {
  let secret: string;
  let customerId: string;
  beforeEach(async () => {
    g.__brainStore = new MemoryStore();
    const c = await createCustomer("audit test");
    secret = c.secret;
    customerId = c.customer.customerId;
    const now = Date.now();
    const rc = signedReceipt("ij-1", now - 60_000);
    await g.__brainStore.putDoc("receipt", rc.receiptId, rc, { at: rc.completedAt, key: rc.source });
    await recordRequest({ customerId, at: now - 60_000, model: rc.model, endpoint: "chat.completions", route: { target: "NATIVE_NETWORK", providerId: "native" }, nodesUsed: ["N-ABCDEF01"], inputUnits: 10, outputUnits: 20, cost: 0.001, latencyMs: 1000, receiptId: rc.receiptId, ok: true, source: "REAL" });
    await recordRequest({ customerId, at: now - 30_000, model: "brain/embed", endpoint: "embeddings", route: { target: "EXTERNAL_MODEL", providerId: "external" }, nodesUsed: [], inputUnits: 5, outputUnits: 0, cost: null, latencyMs: 200, receiptId: null, ok: true, source: "REAL" });
    // Another customer's request must never appear.
    await recordRequest({ customerId: "someone-else", at: now - 10_000, model: "brain/auto", endpoint: "chat.completions", route: null, nodesUsed: [], inputUnits: 1, outputUnits: 1, cost: 5, latencyMs: 1, receiptId: null, ok: true, source: "REAL" });
  });

  it("rejects missing keys", async () => {
    const r = await GET(req("http://x/api/v1/receipts"));
    expect(r.status).toBe(401);
  });

  it("returns only the caller's requests, with receipts and verification", async () => {
    const r = await GET(req("http://x/api/v1/receipts?verify=1", secret));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.customer.id).toBe(customerId);
    expect(j.summary).toMatchObject({ requests: 2, ok: 2, withReceipt: 1, signed: 1, costUsd: 0.001 });
    const signed = j.rows.find((x: { receiptId: string | null }) => x.receiptId);
    expect(signed.receipt.attestation.kind).toBe("signature");
    expect(signed.verified).toEqual({ ok: true });
    const unpriced = j.rows.find((x: { receiptId: string | null }) => !x.receiptId);
    expect(unpriced.costUsd).toBeNull();
    expect(unpriced.verified).toBeNull();
  });

  it("exports csv with one row per request", async () => {
    const r = await GET(req("http://x/api/v1/receipts?format=csv", secret));
    expect(r.headers.get("content-type")).toContain("text/csv");
    const text = await r.text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith("requestId,at,atIso,model")).toBe(true);
    expect(text).toContain("r-ij-1");
  });

  it("respects the time window", async () => {
    const r = await GET(req(`http://x/api/v1/receipts?from=${Date.now() - 45_000}`, secret));
    const j = await r.json();
    expect(j.summary.requests).toBe(1);
    expect(j.rows[0].endpoint).toBe("embeddings");
  });

  it("verifies a signed receipt publicly and detects tampering", async () => {
    const ok = await VERIFY(req("http://x/api/receipts/r-ij-1/verify"));
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.signed).toBe(true);
    expect(j.valid).toBe(true);
    expect(j.canonical.storedHash).toBe(j.canonical.recomputedHash);

    const tampered = signedReceipt("ij-2", Date.now());
    tampered.canonical!.body = { ...tampered.canonical!.body, model: "someone-else/model" };
    await g.__brainStore!.putDoc("receipt", tampered.receiptId, tampered, { at: tampered.completedAt, key: tampered.source });
    const bad = await (await VERIFY(req("http://x/api/receipts/r-ij-2/verify"))).json();
    expect(bad.valid).toBe(false);
    expect(bad.reason).toBe("hash mismatch");

    const missing = await VERIFY(req("http://x/api/receipts/r-nope/verify"));
    expect(missing.status).toBe(404);
  });
});
