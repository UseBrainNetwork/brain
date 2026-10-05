import { body, nodeRoute } from "@/api/http";
import { type PlanId, planById, plans } from "@/lib/plans";
import { ensureAccount } from "@/services/accounts";
import { json } from "@/services/security";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

/** Records that the signed-in account wants a coming-soon plan. One row per account and plan; no email, no charge. */
export const POST = nodeRoute(async (req) => {
  const { account, setCookie } = await ensureAccount(req);
  const { plan } = await body<{ plan?: string }>(req);
  if (!plan || !plans().some((p) => p.id === plan && p.placeholder)) return json({ error: { code: "bad_request", message: "unknown or already available plan" } }, 400);
  const id = `${account.accountId}:${plan}`;
  const store = getStore();
  const existing = await store.getDoc<{ at: number }>("interest", id);
  if (!existing) await store.putDoc("interest", id, { accountId: account.accountId, plan: plan as PlanId, at: Date.now() }, { at: Date.now(), key: plan });
  const res = json({ ok: true, plan: planById(plan as PlanId).name, already: Boolean(existing) });
  if (setCookie) res.headers.set("set-cookie", setCookie);
  return res;
}, 20);

export const GET = nodeRoute(async (req) => {
  const { account, setCookie } = await ensureAccount(req);
  const all = await getStore().listDocs<{ accountId: string; plan: PlanId }>("interest", { limit: 5000 });
  const res = json({ plans: all.filter((d) => d.accountId === account.accountId).map((d) => d.plan) });
  if (setCookie) res.headers.set("set-cookie", setCookie);
  res.headers.set("cache-control", "no-store");
  return res;
}, 60);
