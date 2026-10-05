import type { AccountingEvent } from "@/domain/economy";
import { type Plan, paymentsConnected, planById } from "@/lib/plans";
import type { Account } from "./accounts";
import { listEvents } from "./accounting";
import { balance, type CreditBalance, offsetFromEarning } from "./credits";
import { usage } from "./customers";
import { getStore } from "./store";

/**
 * One view that joins the two sides of a person: what they use (credits, requests) and what
 * their machines earn (REAL COMPUTE_PROVIDER_EARNED lines for nodes their wallet powers).
 *
 * NET = compute earnings − usage cost, in USD, from REAL lines only. Earnings are mirrored into
 * the credit ledger as COMPUTE_OFFSET so usage can be paid with compute. That is a ledger
 * primitive: nothing is paid out and nothing is counted as revenue here.
 */
export interface AccountSummary {
  account: Account;
  plan: Plan;
  paymentsConnected: boolean;
  credits: CreditBalance;
  usage: Awaited<ReturnType<typeof usage>>;
  compute: {
    wallet: string | null;
    /** Nodes (ids) whose verified wallet is this account's wallet. */
    nodeIds: string[];
    nodesOnline: number;
    /** REAL USD owed to those nodes, accrued, not paid. null when there is no wallet. */
    earnedUsd: number | null;
    earningEvents: AccountingEvent[];
  };
  /** earnedUsd − usage cost. null when either side is UNKNOWN or there is no wallet. */
  netUsd: number | null;
}

export async function accountSummary(account: Account): Promise<AccountSummary> {
  const store = getStore();
  const plan = planById(account.plan);
  let nodeIds: string[] = [];
  let nodesOnline = 0;
  let earningEvents: AccountingEvent[] = [];
  if (account.wallet) {
    const nodes = (await store.listNodes()).filter((n) => n.walletVerified && n.walletAddress === account.wallet);
    nodeIds = nodes.map((n) => n.id);
    nodesOnline = nodes.filter((n) => n.status === "idle" || n.status === "computing").length;
    if (nodeIds.length) {
      const ids = new Set(nodeIds);
      // REAL only. SIM accounting lives under its own key and is never read here.
      earningEvents = (await listEvents("REAL", 5000)).filter((e) => e.type === "COMPUTE_PROVIDER_EARNED" && e.relatedNodeId && ids.has(e.relatedNodeId));
      for (const e of earningEvents) await offsetFromEarning(account, e);
    }
  }
  const [credits, use] = await Promise.all([balance(account.accountId), usage(`acct:${account.accountId}`, 200)]);
  const earnedUsd = account.wallet ? earningEvents.reduce((s, e) => s + e.amount, 0) : null;
  const usageUsd = use.cost;
  const netUsd = earnedUsd == null || (use.requests > 0 && usageUsd == null) ? null : earnedUsd - (usageUsd ?? 0);
  return {
    account,
    plan,
    paymentsConnected: paymentsConnected(),
    credits,
    usage: use,
    compute: { wallet: account.wallet ?? null, nodeIds, nodesOnline, earnedUsd, earningEvents },
    netUsd,
  };
}
