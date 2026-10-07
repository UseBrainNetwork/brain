import { body, nodeRoute } from "@/api/http";
import { type PlanId, paymentsConnected, planById, plans } from "@/lib/plans";
import { ensureAccount } from "@/services/accounts";
import { accountSummary } from "@/services/accountSummary";
import { PaymentError, buildTransaction, confirmIntent, createIntent, priceFor, type PayCurrency } from "@/services/payments";
import { json } from "@/services/security";
import { solUsd } from "@/services/solPrice";
import { activatePaid } from "@/services/subscriptions";
import { isSolanaAddress } from "@/services/wallet";

export const dynamic = "force-dynamic";

const fail = (e: unknown) => (e instanceof PaymentError ? json({ error: { code: e.code, message: e.message } }, e.status) : null);

/** Quotes for every paid plan in both currencies, so the pricing page can show what a plan costs on chain right now. */
export const GET = nodeRoute(async () => {
  const quote = await solUsd();
  const out = [];
  for (const p of plans().filter((x) => x.placeholder)) {
    const usdc = await priceFor(p, "USDC");
    out.push({ plan: p.id, usd: p.priceUsd, usdc: usdc.amount, sol: quote ? (await priceFor(p, "SOL")).amount : null });
  }
  const res = json({ enabled: paymentsConnected(), solUsd: quote, plans: out });
  res.headers.set("cache-control", "no-store");
  return res;
}, 60);

/**
 * Start a purchase: creates a payment intent for the signed-in account and returns the unsigned
 * transaction the buyer's wallet must sign and send. `payer` is the paying wallet's address.
 */
export const POST = nodeRoute(async (req) => {
  const { account, setCookie } = await ensureAccount(req);
  const b = await body<{ plan?: string; currency?: string; payer?: string }>(req);
  const plan = String(b.plan ?? "") as PlanId;
  const currency = (b.currency === "SOL" ? "SOL" : "USDC") as PayCurrency;
  if (!plans().some((p) => p.id === plan)) return json({ error: { code: "bad_request", message: "unknown plan" } }, 400);
  if (!b.payer || !isSolanaAddress(b.payer)) return json({ error: { code: "bad_request", message: "payer must be a Solana address" } }, 400);
  try {
    const intent = await createIntent(account, plan, currency);
    const tx = await buildTransaction(intent, b.payer);
    const res = json({ intent, ...tx, plan: planById(plan).name });
    if (setCookie) res.headers.set("set-cookie", setCookie);
    return res;
  } catch (e) {
    return fail(e) ?? Promise.reject(e);
  }
}, 20);

/** Confirm a purchase: looks the signature up on chain, verifies it against the intent, activates the plan. */
export const PATCH = nodeRoute(async (req) => {
  const { account, setCookie } = await ensureAccount(req);
  const b = await body<{ intentId?: string; signature?: string }>(req);
  if (!b.intentId || !b.signature) return json({ error: { code: "bad_request", message: "intentId and signature are required" } }, 400);
  try {
    const confirmed = await confirmIntent(account, String(b.intentId), String(b.signature));
    // Activation is idempotent per intent (the PURCHASE grant id is the intent id), so re-confirming is safe.
    await activatePaid(account, confirmed);
    const summary = await accountSummary(account);
    const res = json({ ok: true, payment: confirmed, summary });
    if (setCookie) res.headers.set("set-cookie", setCookie);
    return res;
  } catch (e) {
    return fail(e) ?? Promise.reject(e);
  }
}, 60);
