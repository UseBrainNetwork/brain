import { randomUUID } from "node:crypto";
import type { AccountingEvent, AccountingEventType, ComputeReceipt, EconomicsSnapshot, Source, SumCell } from "@/domain/economy";
import { defaultRevenueSplit } from "@/rewards/config";
import { eventBus } from "./eventBus";
import { getStore } from "./store";

/**
 * Accounting ledger. Append-only events; every aggregate is computed per `source`.
 *
 * INVARIANT: SIMULATED events never enter REAL totals (and vice versa). `snapshot()` filters on
 * source before summing; there is no code path that sums across sources.
 * INVARIANT: clients cannot write here. Only server services call `record()`.
 */

export async function record(e: Omit<AccountingEvent, "id">): Promise<AccountingEvent> {
  if (!(e.amount >= 0) || !Number.isFinite(e.amount)) throw new Error("accounting: amount must be a finite non-negative number");
  if (e.settlement === "settled" && !e.transactionReference) throw new Error("accounting: settled events need a transactionReference");
  const ev: AccountingEvent = { id: randomUUID(), ...e };
  await getStore().putDoc("accounting", ev.id, ev, { at: ev.timestamp, key: ev.source });
  eventBus.publish({ type: "accounting.recorded", at: ev.timestamp, event: ev });
  return ev;
}

export async function listEvents(source: Source, limit = 100, from?: number, to?: number) {
  return getStore().listDocs<AccountingEvent>("accounting", { key: source, limit, from, to });
}

function cell(events: AccountingEvent[], type: AccountingEventType, currency: AccountingEvent["currency"]): SumCell {
  const rows = events.filter((e) => e.type === type && e.currency === currency);
  const sum = (s: AccountingEvent["settlement"]) => {
    const r = rows.filter((e) => e.settlement === s);
    return r.length ? r.reduce((a, e) => a + e.amount, 0) : null;
  };
  return { settled: sum("settled"), accrued: sum("accrued"), count: rows.length };
}

/** Aggregate one source over a window. Cells are null when there is NOT ENOUGH DATA. */
/** `to` is exclusive; the default includes events recorded in the current millisecond. */
export async function snapshot(source: Source, from = 0, to = Date.now() + 1, receipts?: ComputeReceipt[]): Promise<EconomicsSnapshot> {
  const events = await getStore().listDocs<AccountingEvent>("accounting", { key: source, from, to, limit: 50_000 });
  // Belt and braces: the key filter already did this, but the invariant is cheap to re-assert.
  const own = events.filter((e) => e.source === source);
  const customersPaid = cell(own, "CUSTOMER_PAYMENT", "USD");
  const providersEarned = cell(own, "COMPUTE_PROVIDER_EARNED", "USD");
  const creatorRewards = cell(own, "CREATOR_REWARD_RECEIVED", "SOL");
  const protocolRevenue = cell(own, "PROTOCOL_REVENUE", "USD");
  const infrastructureCost = cell(own, "INFRASTRUCTURE_COST", "USD");

  const total = (c: SumCell) => (c.settled ?? 0) + (c.accrued ?? 0);
  const haveMargin = customersPaid.count > 0 && providersEarned.count > 0;
  const paid = total(customersPaid);
  const networkMargin = haveMargin && paid > 0 ? (paid - total(providersEarned) - total(infrastructureCost)) / paid : null;

  let costPer1MUnits: number | null = null;
  if (receipts) {
    const priced = receipts.filter((r) => r.source === source && r.customerCost && r.totalComputeUnits > 0);
    const units = priced.reduce((s, r) => s + r.totalComputeUnits, 0);
    const usd = priced.reduce((s, r) => s + (r.customerCost?.amount ?? 0), 0);
    costPer1MUnits = units > 0 ? (usd / units) * 1_000_000 : null;
  }
  return { source, from, to, customersPaid, providersEarned, creatorRewards, protocolRevenue, infrastructureCost, networkMargin, costPer1MUnits, events: own.length };
}

/**
 * Accrue the economics of one receipt. Only runs when the receipt carries a price; unpriced work
 * produces no monetary events (it is still credited as compute units on the nodes).
 */
export async function accrueReceipt(r: ComputeReceipt, nodeUnits: Record<string, number>) {
  if (!r.customerCost) return [];
  const split = defaultRevenueSplit.inferenceRevenue;
  const out: AccountingEvent[] = [];
  const base = { currency: "USD" as const, timestamp: r.completedAt, relatedJobId: r.jobId, relatedReceiptId: r.receiptId, source: r.source, settlement: "accrued" as const };
  out.push(await record({ ...base, type: "CUSTOMER_PAYMENT", amount: r.customerCost.amount, note: `${r.customerCost.basis}; no payment received yet` }));
  const providerTotal = r.providerCompensation?.amount ?? 0;
  const unitSum = Object.values(nodeUnits).reduce((s, u) => s + u, 0);
  if (providerTotal > 0 && unitSum > 0) {
    for (const [nodeId, units] of Object.entries(nodeUnits)) {
      if (units <= 0) continue;
      out.push(await record({ ...base, type: "COMPUTE_PROVIDER_EARNED", amount: providerTotal * (units / unitSum), relatedNodeId: nodeId, note: `${units} verified compute units · ${Math.round(split.contributors * 100)}% provider share` }));
    }
  }
  if (r.protocolRevenue && r.protocolRevenue.amount > 0) out.push(await record({ ...base, type: "PROTOCOL_REVENUE", amount: r.protocolRevenue.amount, note: "buyback + treasury share" }));
  const infra = r.customerCost.amount * split.infrastructure;
  if (infra > 0) out.push(await record({ ...base, type: "INFRASTRUCTURE_COST", amount: infra, note: "infrastructure share of list price" }));
  return out;
}
