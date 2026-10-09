import { nodeRoute } from "@/api/http";
import { PaymentError, buildTransaction } from "@/services/payments";
import { getCallQuote, paymentRequired } from "@/services/payPerCall";
import { json } from "@/services/security";
import { isSolanaAddress } from "@/services/wallet";

export const dynamic = "force-dynamic";

/**
 * GET /v1/pay/:id/transaction?payer=<wallet> — the unsigned Solana transaction that pays a
 * pay-per-call quote: transfer to the protocol wallet for the quoted amount plus the memo that
 * names the quote. Sign and send it from the payer wallet, then re-send the request with
 * `x-brain-payment: <id>:<signature>`. Convenience only; any wallet can build the same transfer.
 */
export const GET = nodeRoute(async (req) => {
  const u = new URL(req.url);
  const parts = u.pathname.split("/");
  const id = decodeURIComponent(parts[parts.length - 2] ?? "");
  const payer = u.searchParams.get("payer") ?? "";
  if (!isSolanaAddress(payer)) return json({ error: { code: "bad_request", message: "payer must be a Solana address" } }, 400);
  const q = await getCallQuote(id);
  if (!q || q.kind !== "call") return json({ error: { code: "not_found", message: "Unknown payment quote." } }, 404);
  if (q.status === "redeemed") return json({ error: { code: "signature_used", message: "This quote has already been used." } }, 409);
  if (Date.now() > q.expiresAt) return json({ error: { code: "intent_expired", message: "This quote expired; ask for a new one." } }, 410);
  try {
    const tx = await buildTransaction({ id: q.id, accountId: "", plan: "FREE", currency: q.currency, amountUsd: q.amountUsd, amount: q.amount, baseUnits: q.baseUnits, quote: q.quote, to: q.to, createdAt: q.createdAt, expiresAt: q.expiresAt, status: "pending", source: "REAL" }, payer);
    return json({ payment: paymentRequired(q), ...tx }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof PaymentError) return json({ error: { code: e.code, message: e.message } }, e.status);
    return json({ error: { code: "rpc_unavailable", message: "Could not reach the Solana RPC to fetch a blockhash. Build the transfer in your wallet instead." } }, 503);
  }
}, 60);
