import { nodeRoute } from "@/api/http";
import { ensureAccount } from "@/services/accounts";
import { accountSummary } from "@/services/accountSummary";
import { ensureMonthlyGrant } from "@/services/credits";
import { json } from "@/services/security";
import { maintainHolder } from "@/services/subscriptions";

export const dynamic = "force-dynamic";

/** The signed-in account (created on first call) with plan, credits, usage and compute earnings. */
export const GET = nodeRoute(async (req) => {
  const { account: raw, setCookie } = await ensureAccount(req);
  const account = await maintainHolder(raw);
  await ensureMonthlyGrant(account);
  const summary = await accountSummary(account);
  const res = json({ summary });
  if (setCookie) res.headers.set("set-cookie", setCookie);
  res.headers.set("cache-control", "no-store");
  return res;
}, 120);
