import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputeReceipt } from "@/domain/economy";
import { MemoryStore } from "./store";
import { type Account, createAccount, signSession, verifySession } from "./accounts";
import { balance, consumeForReceipt, ensureMonthlyGrant, mayConsume, offsetFromEarning } from "./credits";

vi.mock("server-only", () => ({}));

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };

const receipt = (over: Partial<ComputeReceipt>): ComputeReceipt => ({
  receiptId: "r-1",
  jobId: "c-1",
  workloadType: "chat",
  model: "m",
  createdAt: 1,
  completedAt: 2,
  nodesUsed: [],
  workUnits: 1,
  verifiedWorkUnits: 0,
  failedWorkUnits: 0,
  reassignedWorkUnits: 0,
  totalComputeUnits: 0,
  executionTimeMs: 1,
  verificationMethod: "unverified-provider-response",
  verificationConfidence: 0,
  resultHash: "x",
  resultHashLabel: "sha256 of provider response",
  attestation: { kind: "none" },
  source: "REAL",
  customerCost: { amount: 0.002, currency: "USD", basis: "list-price" },
  providerCompensation: null,
  protocolRevenue: null,
  route: { target: "EXTERNAL_MODEL", providerId: "external" },
  status: "VERIFIED",
  ...over,
});

describe("accounts & sessions", () => {
  beforeEach(() => {
    g.__brainStore = new MemoryStore();
  });
  it("signed sessions round-trip and reject tampering or expiry", async () => {
    const a = await createAccount();
    expect(verifySession(signSession(a.accountId))).toBe(a.accountId);
    expect(verifySession(signSession(a.accountId).replace(/.$/, "0"))).toBeNull();
    expect(verifySession(signSession(a.accountId, Date.now() - 1))).toBeNull();
    expect(verifySession("acc_000000000000.9999999999999.deadbeef")).toBeNull();
  });
});

describe("BRAIN credits", () => {
  let acct: Account;
  beforeEach(async () => {
    g.__brainStore = new MemoryStore();
    process.env.BRAIN_CREDIT_USD = "0.001";
    acct = await createAccount();
  });

  it("grants the plan allowance once per month", async () => {
    const a = await ensureMonthlyGrant(acct, Date.UTC(2026, 9, 4));
    const b = await ensureMonthlyGrant(acct, Date.UTC(2026, 9, 20));
    expect(a?.id).toBe(b?.id);
    const next = await ensureMonthlyGrant(acct, Date.UTC(2026, 10, 1));
    expect(next?.id).not.toBe(a?.id);
    const bal = await balance(acct.accountId);
    expect(bal.granted).toBe(1000);
    expect(bal.events.filter((e) => e.type === "GRANT_INCLUDED")).toHaveLength(2);
  });

  it("consumes credits from the receipt's real cost and preserves the economics", async () => {
    await ensureMonthlyGrant(acct);
    await consumeForReceipt(acct, receipt({}), { orderId: "o-1", inputUnits: 10, outputUnits: 5, providerCostUsd: 0.0004 });
    const bal = await balance(acct.accountId);
    expect(bal.consumed).toBeCloseTo(2);
    expect(bal.balance).toBeCloseTo(498);
    const c = bal.events.find((e) => e.type === "CONSUME")!;
    expect(c.detail).toMatchObject({ orderId: "o-1", receiptId: "r-1", model: "m", inputUnits: 10, outputUnits: 5, providerCostUsd: 0.0004, customerCostUsd: 0.002, route: { target: "EXTERNAL_MODEL", providerId: "external" } });
  });

  it("UNKNOWN cost deducts nothing and is flagged", async () => {
    await ensureMonthlyGrant(acct);
    await consumeForReceipt(acct, receipt({ customerCost: null }));
    const bal = await balance(acct.accountId);
    expect(bal.consumed).toBe(0);
    expect(bal.unknownCostRequests).toBe(1);
    expect(bal.events.find((e) => e.type === "CONSUME")?.costUnknown).toBe(true);
  });

  it("FREE accounts stop at zero", async () => {
    await ensureMonthlyGrant(acct);
    await consumeForReceipt(acct, receipt({ receiptId: "r-big", customerCost: { amount: 0.5, currency: "USD", basis: "list-price" } }));
    const bal = await balance(acct.accountId);
    expect(bal.balance).toBeCloseTo(0);
    expect(mayConsume(bal)).toBe(false);
  });

  it("REAL compute earnings offset usage exactly once; SIM never does", async () => {
    await ensureMonthlyGrant(acct);
    const ev = { id: "ae-1", amount: 0.01, timestamp: 5, relatedNodeId: "8A21", source: "REAL" as const };
    await offsetFromEarning(acct, ev);
    await offsetFromEarning(acct, ev);
    const bal = await balance(acct.accountId);
    expect(bal.offset).toBeCloseTo(10);
    expect(bal.events.filter((e) => e.type === "COMPUTE_OFFSET")).toHaveLength(1);
    await expect(offsetFromEarning(acct, { ...ev, id: "ae-2", source: "SIMULATED" })).rejects.toThrow(/REAL/);
  });
});
