import { randomBytes } from "node:crypto";
import { chatChars } from "@/domain/chat";
import { priceForTokens, tokenListPricePer1MUsd } from "@/lib/pricing";
import { paymentsConnected } from "@/lib/plans";
import { protocolWallet } from "@/lib/site";
import { INTENT_TTL_MS, PaymentError, type ParsedPaymentTx, type PayCurrency, type PaymentIntent, verifyParsedTx } from "./payments";
import { sha256 } from "./security";
import { LAMPORTS, rpc, rpcUrl } from "./solana";
import { solUsd, type SolQuote } from "./solPrice";
import { getStore } from "./store";

/**
 * Pay per call, no account. The x402 shape on Solana:
 *
 *   1. POST /v1/chat/completions with no key and `x-brain-pay: sol|usdc` → 402 with a quote: the
 *      exact amount, destination, memo and expiry for THIS request (bound to a hash of its body).
 *   2. The caller pays from any wallet (or asks /v1/pay/:id/transaction for the unsigned tx).
 *   3. The caller re-sends the same body with `x-brain-payment: <quoteId>:<txSignature>`. The server
 *      reads the transaction from the chain, checks destination, amount, memo and that the body still
 *      matches, marks the signature spent, and serves the request as customer `pay:<payer>`.
 *
 * Prices come from the configured list price only. With no list price there is no quote and the
 * 402 says so; nothing is invented. A quote prices the request's budget (prompt + max_tokens): the
 * caller pays for what they asked to be able to use, like a prepaid meter, and the receipt shows
 * what was actually used at list price. Confirmed call payments join plan sales in the hourly pool.
 */
export interface CallQuote {
  id: string;
  kind: "call";
  currency: PayCurrency;
  amountUsd: number;
  amount: number;
  baseUnits: number;
  quote?: SolQuote;
  to: string;
  memo: string;
  /** sha256 of the request body with pay fields removed; the paid request must hash the same. */
  requestHash: string;
  model: string;
  budgetTokens: number;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "confirmed" | "redeemed" | "expired";
  signature?: string;
  confirmedAt?: number;
  payer?: string;
  redeemedAt?: number;
  orderId?: string;
  receiptId?: string;
  source: "REAL";
}

const USDC_DECIMALS = 6;
/** Below this a Solana transaction fee dwarfs the charge; the floor is published with every quote. */
export const MIN_CALL_USD = (() => {
  const v = Number(process.env.BRAIN_PAYCALL_MIN_USD);
  return Number.isFinite(v) && v > 0 ? v : 0.001;
})();

export const isPayCurrency = (s: unknown): s is PayCurrency => s === "SOL" || s === "USDC";

/** The body fields that carry payment instructions and must not affect the price or the hash. */
const PAY_FIELDS = new Set(["pay", "payment"]);

export function requestHashOf(body: Record<string, unknown>): string {
  const keys = Object.keys(body).filter((k) => !PAY_FIELDS.has(k)).sort();
  return sha256(JSON.stringify(keys.map((k) => [k, body[k]])));
}

/** Tokens the request may consume at most: prompt estimate plus the completion budget. */
const DEFAULT_MAX_TOKENS = 2048;

export function budgetTokens(chat: { messages: Parameters<typeof chatChars>[0]; tools?: Parameters<typeof chatChars>[1]; max_tokens?: number }): number {
  return Math.ceil(chatChars(chat.messages, chat.tools) / 4) + (chat.max_tokens ?? DEFAULT_MAX_TOKENS);
}

export async function quoteCall(body: Record<string, unknown>, chat: { model: string; messages: Parameters<typeof chatChars>[0]; tools?: Parameters<typeof chatChars>[1]; max_tokens?: number }, currency: PayCurrency, now = Date.now()): Promise<CallQuote> {
  if (!paymentsConnected()) throw new PaymentError("payments_off", "Pay-per-call is switched off on this server.", 503);
  const per1M = tokenListPricePer1MUsd();
  const tokens = budgetTokens(chat);
  const priced = priceForTokens(tokens, per1M);
  if (priced == null) throw new PaymentError("no_sol_price", "No list price is configured, so this request cannot be quoted. Use an API key instead.", 503);
  const amountUsd = Math.max(MIN_CALL_USD, priced);
  let amount: number;
  let baseUnits: number;
  let quote: SolQuote | undefined;
  if (currency === "USDC") {
    baseUnits = Math.max(1, Math.ceil(amountUsd * 10 ** USDC_DECIMALS));
    amount = baseUnits / 10 ** USDC_DECIMALS;
  } else {
    const q = await solUsd();
    if (!q) throw new PaymentError("no_sol_price", "No SOL/USD price is available right now. Pay in USDC, or try again in a minute.", 503);
    quote = q;
    baseUnits = Math.max(1000, Math.ceil((amountUsd / q.usd) * LAMPORTS / 1000) * 1000);
    amount = baseUnits / LAMPORTS;
  }
  const id = `call_${randomBytes(8).toString("hex")}`;
  const q: CallQuote = {
    id,
    kind: "call",
    currency,
    amountUsd,
    amount,
    baseUnits,
    quote,
    to: protocolWallet.address,
    memo: `brain:${id}`,
    requestHash: requestHashOf(body),
    model: chat.model,
    budgetTokens: tokens,
    createdAt: now,
    expiresAt: now + INTENT_TTL_MS,
    status: "pending",
    source: "REAL",
  };
  await getStore().putDoc("payment", id, q, { at: now, key: "call" });
  return q;
}

export const getCallQuote = (id: string) => getStore().getDoc<CallQuote>("payment", id);

/** The same checks as a plan purchase; a CallQuote has the fields verifyParsedTx reads. */
const asIntent = (q: CallQuote): PaymentIntent => ({ id: q.id, accountId: "", plan: "FREE", currency: q.currency, amountUsd: q.amountUsd, amount: q.amount, baseUnits: q.baseUnits, quote: q.quote, to: q.to, createdAt: q.createdAt, expiresAt: q.expiresAt, status: "pending", source: "REAL" });

/**
 * Verify a payment for a quote and mark it redeemed for this request. One signature pays for one
 * quote; one quote serves one request. The request body must hash to what was quoted.
 */
export async function redeemCall(quoteId: string, signature: string, body: Record<string, unknown>, now = Date.now()): Promise<CallQuote> {
  if (!/^call_[a-f0-9]{16}$/.test(quoteId)) throw new PaymentError("intent_not_found", "Unknown payment quote.", 404);
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,120}$/.test(signature)) throw new PaymentError("bad_signature", "That does not look like a transaction signature.");
  const store = getStore();
  const q = await getCallQuote(quoteId);
  if (!q || q.kind !== "call") throw new PaymentError("intent_not_found", "Unknown payment quote.", 404);
  if (q.status === "redeemed") throw new PaymentError("signature_used", "This quote has already been used for a request.", 409);
  if (q.requestHash !== requestHashOf(body)) throw new PaymentError("bad_signature", "The request differs from the one that was quoted. Ask for a new quote.", 409);
  if (now > q.expiresAt + 10 * 60_000) throw new PaymentError("intent_expired", "This quote expired. Ask for a new one; if the transfer went through, contact us with the signature.");
  return store.withLock(`payment:${signature}`, async () => {
    const used = await store.getDoc<{ intentId: string }>("payment", `sig:${signature}`);
    if (used && used.intentId !== q.id) throw new PaymentError("signature_used", "That transaction has already been used.", 409);
    let payer = q.payer;
    if (q.status !== "confirmed" || q.signature !== signature) {
      const { url } = rpcUrl();
      const tx = await rpc<ParsedPaymentTx | null>(url, "getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      payer = verifyParsedTx(asIntent(q), tx).payer;
      await store.putDoc("payment", `sig:${signature}`, { intentId: q.id, accountId: `pay:${payer}`, at: now }, { at: now, key: "sig" });
    }
    const redeemed: CallQuote = { ...q, status: "redeemed", signature, confirmedAt: q.confirmedAt ?? now, payer, redeemedAt: now };
    await store.putDoc("payment", q.id, redeemed, { at: q.createdAt, key: "call" });
    return redeemed;
  });
}

/** After the request ran: attach the order and receipt so the payment is traceable to what it bought. */
export async function attachCallResult(quoteId: string, orderId: string, receiptId: string | null) {
  const q = await getCallQuote(quoteId);
  if (!q) return;
  await getStore().putDoc("payment", q.id, { ...q, orderId, receiptId: receiptId ?? undefined }, { at: q.createdAt, key: "call" });
}

/** Parses `x-brain-payment: <quoteId>:<signature>`. */
export function parsePaymentHeader(h: string | null): { quoteId: string; signature: string } | null {
  if (!h) return null;
  const i = h.indexOf(":");
  if (i < 0) return null;
  return { quoteId: h.slice(0, i).trim(), signature: h.slice(i + 1).trim() };
}

/** What a 402 carries: everything needed to pay without any further call. */
export function paymentRequired(q: CallQuote) {
  return {
    id: q.id,
    currency: q.currency,
    amount: q.amount,
    amountUsd: q.amountUsd,
    baseUnits: q.baseUnits,
    to: q.to,
    memo: q.memo,
    cluster: protocolWallet.cluster,
    expiresAt: q.expiresAt,
    budgetTokens: q.budgetTokens,
    minUsd: MIN_CALL_USD,
    ...(q.quote ? { solUsd: q.quote.usd } : {}),
    transactionUrl: `/v1/pay/${q.id}/transaction?payer=<your wallet>`,
    then: `Re-send the same request with header x-brain-payment: ${q.id}:<transaction signature>`,
  };
}
