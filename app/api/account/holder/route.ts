import { nodeRoute } from "@/api/http";
import { holderPlans } from "@/lib/plans";
import { ensureAccount } from "@/services/accounts";
import { accountSummary } from "@/services/accountSummary";
import { json } from "@/services/security";
import { refreshHolder } from "@/services/subscriptions";

export const dynamic = "force-dynamic";

/**
 * Re-read the linked wallet's BRAIN balance from the chain and apply holder access. Needs a wallet
 * attached to the session by signature (/api/wallet/verify). Nothing is spent or locked.
 */
export const POST = nodeRoute(async (req) => {
  const { account, setCookie } = await ensureAccount(req);
  if (holderPlans().length === 0) return json({ error: { code: "not_offered", message: "Holder access is not offered right now." } }, 404);
  if (!account.wallet) return json({ error: { code: "no_wallet", message: "Link your wallet first." } }, 400);
  const r = await refreshHolder(account);
  const summary = await accountSummary(r.account, { holderBalance: r.balance });
  const res = json({ ok: true, balance: r.balance, unlocks: r.unlocks?.id ?? null, summary });
  if (setCookie) res.headers.set("set-cookie", setCookie);
  res.headers.set("cache-control", "no-store");
  return res;
}, 20);
