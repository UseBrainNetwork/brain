import { PLAN_PERIOD_MS, type Plan, creditUsd, holderPlans, planById, planRank, plansUnlockedByHolding } from "@/lib/plans";
import { type Account, setPlan } from "./accounts";
import type { CreditEvent } from "./credits";
import type { PaymentIntent } from "./payments";
import { getStore } from "./store";
import { getHoldings } from "./wallet";

/**
 * Who is on which plan and why. Two ways onto a paid plan:
 *
 *   paid    a confirmed on-chain payment (services/payments.ts) buys 30 days. Paying again for the
 *           same plan adds 30 days to the end; paying for a different plan starts a fresh 30 days on
 *           that plan from now. The plan's credits are granted per payment as a PURCHASE line.
 *
 *   holder  a linked wallet holding at least the plan's `holdTokens` BRAIN unlocks it for as long as
 *           the holding lasts. The balance is read live from the chain (never a simulated figure),
 *           re-read every few hours, and the plan drops back to FREE when the holding falls below.
 *           Credits are the plan's monthly allowance, granted per calendar month like FREE.
 *
 * This is utility for the token, not yield: nothing is locked, nothing accrues, and selling the
 * tokens simply ends the access at the next check.
 */

/** How long a holder plan stays valid between balance checks; a lapsed check reverts to FREE. */
export const HOLDER_GRACE_MS = 7 * 24 * 3600_000;
/** Re-read a holder's balance when the last read is older than this. */
export const HOLDER_RECHECK_MS = 6 * 3600_000;

export interface PlanStatus {
  plan: Plan;
  basis: "free" | "paid" | "holder";
  until: number | null;
  /** Holder access: thresholds offered, the wallet's live balance when known, and the best plan it unlocks. */
  holder: {
    offered: { plan: Plan["id"]; holdTokens: number }[];
    wallet: string | null;
    balance: number | null;
    unlocks: Plan["id"] | null;
    checkedAt: number | null;
  };
}

/** Activate or extend a paid plan from a confirmed payment, and grant its credits once per payment. */
export async function activatePaid(account: Account, intent: PaymentIntent, now = Date.now()): Promise<Account> {
  if (intent.status !== "confirmed") throw new Error("activatePaid: intent is not confirmed");
  const plan = planById(intent.plan);
  const store = getStore();
  const grantId = `purchase:${intent.id}`;
  const already = await store.getDoc<CreditEvent>("credit", grantId);
  // One payment activates once: a repeated confirm of the same intent must not add another period.
  if (already) return account;
  {
    const ev: CreditEvent = {
      id: grantId,
      accountId: account.accountId,
      at: now,
      type: "PURCHASE",
      credits: plan.includedCredits,
      usd: intent.amountUsd,
      detail: { orderId: intent.id },
      source: "REAL",
    };
    await store.putDoc("credit", ev.id, ev, { at: ev.at, key: account.accountId });
  }
  const samePlanActive = account.planBasis === "paid" && account.plan === plan.id && (account.planUntil ?? 0) > now;
  const until = samePlanActive ? (account.planUntil as number) + PLAN_PERIOD_MS : now + PLAN_PERIOD_MS;
  return setPlan(account, plan.id, { basis: "paid", until });
}

/**
 * Re-evaluate holder access for the account's linked wallet. Never downgrades an active paid plan
 * of equal or higher rank. Returns the account and what was read.
 */
export async function refreshHolder(account: Account, now = Date.now()): Promise<{ account: Account; balance: number | null; unlocks: Plan | null }> {
  if (!account.wallet || holderPlans().length === 0) return { account, balance: null, unlocks: null };
  const holding = await getHoldings(account.wallet);
  // A simulated balance must never unlock anything real.
  if (holding.provenance !== "live") return { account, balance: null, unlocks: null };
  const unlocks = plansUnlockedByHolding(holding.amount)[0] ?? null;
  const paidActive = account.planBasis === "paid" && (account.planUntil ?? 0) > now;
  if (paidActive && (!unlocks || planRank(account.plan) >= planRank(unlocks.id))) return { account, balance: holding.amount, unlocks };
  if (unlocks) {
    await setPlan(account, unlocks.id, { basis: "holder", until: now + HOLDER_GRACE_MS, checkedAt: now });
  } else if (account.planBasis === "holder") {
    await setPlan(account, "FREE");
  }
  return { account, balance: holding.amount, unlocks };
}

/** On read paths: a holder plan whose last check is stale is re-read from the chain. */
export async function maintainHolder(account: Account, now = Date.now()): Promise<Account> {
  if (account.planBasis !== "holder") return account;
  if (now - (account.holderCheckedAt ?? 0) < HOLDER_RECHECK_MS) return account;
  try {
    return (await refreshHolder(account, now)).account;
  } catch {
    // Chain unreachable: keep the plan until the grace period ends rather than flapping.
    return account;
  }
}

export async function planStatus(account: Account, opts: { balance?: number | null } = {}): Promise<PlanStatus> {
  const plan = planById(account.plan);
  const offered = holderPlans().map((p) => ({ plan: p.id, holdTokens: p.holdTokens as number }));
  const balance = opts.balance ?? null;
  return {
    plan,
    basis: account.plan === "FREE" || !account.planBasis ? "free" : account.planBasis,
    until: account.plan === "FREE" ? null : (account.planUntil ?? null),
    holder: {
      offered,
      wallet: account.wallet ?? null,
      balance,
      unlocks: balance == null ? null : (plansUnlockedByHolding(balance)[0]?.id ?? null),
      checkedAt: account.holderCheckedAt ?? null,
    },
  };
}

/** USD value of a plan's credits, for display. */
export const creditsUsd = (credits: number) => credits * creditUsd();
