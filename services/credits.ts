import { randomUUID } from "node:crypto";
import type { ComputeReceipt, ExecutionTarget, Source } from "@/domain/economy";
import { creditUsd, planById } from "@/lib/plans";
import type { Account } from "./accounts";
import { getStore } from "./store";

/**
 * BRAIN Credits ledger. Credits are a unit of real cost (1 credit = BRAIN_CREDIT_USD), so every
 * CONSUME line preserves the underlying economics: tokens, provider cost, network cost, customer
 * cost, route and model. Nothing here moves money.
 *
 * Event types
 *   GRANT_INCLUDED   monthly allowance of the account's plan (FREE today; PRO/MAX once paid)
 *   CONSUME          one request; credits = customerCost / creditUsd, or UNKNOWN (0 deducted, flagged)
 *   COMPUTE_OFFSET   REAL earnings from nodes this account's wallet powers, credited as usage offset.
 *                    Ledger primitive only: it never becomes a payout and is never counted as revenue.
 *   PURCHASE         a bought plan period's credits, one line per confirmed on-chain payment (services/payments.ts)
 */
export type CreditEventType = "GRANT_INCLUDED" | "CONSUME" | "COMPUTE_OFFSET" | "PURCHASE";

export interface CreditEvent {
  id: string;
  accountId: string;
  at: number;
  type: CreditEventType;
  /** Signed credits. Positive adds to the balance. */
  credits: number;
  /** USD equivalent; null = UNKNOWN. */
  usd: number | null;
  /** True when the request's cost was UNKNOWN; nothing was deducted and the account owes nothing determinable. */
  costUnknown?: boolean;
  /** Economics preserved from the receipt, for CONSUME lines. */
  detail?: {
    orderId?: string;
    receiptId?: string;
    model?: string | null;
    route?: { target: ExecutionTarget; providerId: string } | null;
    inputUnits?: number;
    outputUnits?: number;
    /** What the upstream provider charged BRAIN (null = UNKNOWN). */
    providerCostUsd?: number | null;
    /** What was owed to compute nodes (null = UNKNOWN / none). */
    networkCostUsd?: number | null;
    /** What the customer was charged at list price. */
    customerCostUsd?: number | null;
    verification?: string;
    /** For COMPUTE_OFFSET: which node earned it. */
    nodeId?: string;
    accountingEventId?: string;
  };
  /** Calendar month key for grants, e.g. "2026-10". */
  period?: string;
  source: Source;
}

export interface CreditBalance {
  accountId: string;
  balance: number;
  granted: number;
  consumed: number;
  offset: number;
  /** Requests whose cost was UNKNOWN; they are not in `consumed`. */
  unknownCostRequests: number;
  creditUsd: number;
  events: CreditEvent[];
}

const monthKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

async function write(e: Omit<CreditEvent, "id">) {
  const ev: CreditEvent = { id: randomUUID(), ...e };
  await getStore().putDoc("credit", ev.id, ev, { at: ev.at, key: ev.accountId });
  return ev;
}

export async function creditEvents(accountId: string, limit = 500) {
  return getStore().listDocs<CreditEvent>("credit", { key: accountId, limit });
}

/** Grants the plan's monthly allowance once per calendar month. Idempotent via a deterministic id. */
export async function ensureMonthlyGrant(account: Account, now = Date.now()) {
  const period = monthKey(now);
  // A bought plan's credits arrive as a PURCHASE line per payment (services/subscriptions.ts), not monthly.
  // FREE and holder plans get their monthly allowance here.
  const plan = account.planBasis === "paid" ? planById("FREE") : planById(account.plan);
  if (plan.includedCredits <= 0) return null;
  // The grant id carries the plan, so a holder unlocked mid-month receives that plan's allowance less
  // whatever FREE already granted this month: the month's total is the plan's allowance, never more.
  const id = plan.id === "FREE" ? `grant:${account.accountId}:${period}` : `grant:${account.accountId}:${period}:${plan.id}`;
  const store = getStore();
  const existing = await store.getDoc<CreditEvent>("credit", id);
  if (existing) return existing;
  let credits = plan.includedCredits;
  if (plan.id !== "FREE") {
    const free = await store.getDoc<CreditEvent>("credit", `grant:${account.accountId}:${period}`);
    if (free) credits = Math.max(0, credits - free.credits);
    if (credits <= 0) return null;
  }
  const ev: CreditEvent = { id, accountId: account.accountId, at: now, type: "GRANT_INCLUDED", credits, usd: credits * creditUsd(), period, source: "REAL" };
  await store.putDoc("credit", ev.id, ev, { at: ev.at, key: ev.accountId });
  return ev;
}

export async function balance(accountId: string): Promise<CreditBalance> {
  const events = (await creditEvents(accountId)).sort((a, b) => b.at - a.at);
  const sum = (t: CreditEventType) => events.filter((e) => e.type === t).reduce((s, e) => s + e.credits, 0);
  const granted = sum("GRANT_INCLUDED") + sum("PURCHASE");
  const consumed = Math.abs(sum("CONSUME"));
  const offset = sum("COMPUTE_OFFSET");
  return { accountId, balance: granted + offset - consumed, granted, consumed, offset, unknownCostRequests: events.filter((e) => e.type === "CONSUME" && e.costUnknown).length, creditUsd: creditUsd(), events };
}

/** Record consumption for a completed receipt. UNKNOWN cost deducts nothing and is flagged. */
export async function consumeForReceipt(account: Account, r: ComputeReceipt, extra: { orderId?: string; inputUnits?: number; outputUnits?: number; providerCostUsd?: number | null } = {}) {
  const usd = r.customerCost?.amount ?? null;
  const credits = usd == null ? 0 : -(usd / creditUsd());
  return write({
    accountId: account.accountId,
    at: r.completedAt,
    type: "CONSUME",
    credits,
    usd,
    costUnknown: usd == null,
    detail: {
      orderId: extra.orderId ?? r.orderId,
      receiptId: r.receiptId,
      model: r.model,
      route: r.route ? { target: r.route.target, providerId: r.route.providerId } : null,
      inputUnits: extra.inputUnits,
      outputUnits: extra.outputUnits,
      providerCostUsd: extra.providerCostUsd ?? null,
      networkCostUsd: r.providerCompensation?.amount ?? null,
      customerCostUsd: usd,
      verification: r.verificationMethod,
    },
    source: "REAL",
  });
}

/** Mirror one REAL COMPUTE_PROVIDER_EARNED accounting event into the account as an offset. Idempotent per accounting event. */
export async function offsetFromEarning(account: Account, ev: { id: string; amount: number; timestamp: number; relatedNodeId?: string; source: Source }) {
  if (ev.source !== "REAL") throw new Error("credits: only REAL earnings may offset usage");
  const id = `offset:${account.accountId}:${ev.id}`;
  const store = getStore();
  const existing = await store.getDoc<CreditEvent>("credit", id);
  if (existing) return existing;
  const row: CreditEvent = { id, accountId: account.accountId, at: ev.timestamp, type: "COMPUTE_OFFSET", credits: ev.amount / creditUsd(), usd: ev.amount, detail: { nodeId: ev.relatedNodeId, accountingEventId: ev.id }, source: "REAL" };
  await store.putDoc("credit", row.id, row, { at: row.at, key: account.accountId });
  return row;
}

/** Whether the account may place a request now. FREE accounts stop at zero; paid plans are not enforceable until payments exist. */
export function mayConsume(bal: CreditBalance) {
  return bal.balance > 0;
}
