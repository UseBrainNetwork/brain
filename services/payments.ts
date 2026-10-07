import { randomBytes } from "node:crypto";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { PLAN_PERIOD_MS, type Plan, type PlanId, paymentsConnected, planById } from "@/lib/plans";
import { protocolWallet } from "@/lib/site";
import type { Account } from "./accounts";
import { LAMPORTS, rpc, rpcUrl } from "./solana";
import { type SolQuote, solUsd } from "./solPrice";
import { getStore } from "./store";

/**
 * Plan purchases as Solana transactions. The server builds the exact transfer it expects
 * (destination, amount, a memo carrying the intent id), the buyer signs and sends it from any
 * wallet, and the server then reads the confirmed transaction back from the chain before the
 * plan is activated. Nothing is trusted from the client but a signature to look up.
 *
 *   USD price → USDC, 1:1 (6 decimals), or → SOL at a quoted rate (services/solPrice.ts).
 *   Destination: the protocol wallet. The money is the same money that funds contributor epochs.
 *
 * Replay and theft are prevented by two facts: a confirmed signature can be used once, and the
 * memo must carry the intent id, which is random and bound to the paying account.
 */
export type PayCurrency = "SOL" | "USDC";

export interface PaymentIntent {
  id: string;
  accountId: string;
  plan: PlanId;
  currency: PayCurrency;
  amountUsd: number;
  /** Whole-unit amount in `currency` (SOL or USDC). */
  amount: number;
  /** Smallest units: lamports, or USDC base units (1e-6). */
  baseUnits: number;
  /** The rate used for SOL. Absent for USDC. */
  quote?: SolQuote;
  to: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "confirmed" | "expired";
  signature?: string;
  confirmedAt?: number;
  /** Fee payer observed on chain once confirmed. */
  payer?: string;
  source: "REAL";
}

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC_DECIMALS = 6;
/** Intents are good for 20 minutes: long enough to sign, short enough that a SOL quote stays fair. */
export const INTENT_TTL_MS = 20 * 60_000;
/** Tolerance for rounding on the chain side (never for underpayment by design). */
const UNDERPAY_TOLERANCE = 0.002;

export function usdcMint(): PublicKey {
  const env = process.env.BRAIN_USDC_MINT;
  if (env) return new PublicKey(env);
  return new PublicKey(protocolWallet.cluster === "mainnet-beta" ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
}

const ata = (owner: PublicKey, mint: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

export class PaymentError extends Error {
  constructor(
    public readonly code: "payments_off" | "not_a_paid_plan" | "no_sol_price" | "intent_not_found" | "intent_expired" | "signature_used" | "tx_not_found" | "tx_failed" | "wrong_destination" | "underpaid" | "memo_missing" | "too_early" | "bad_signature",
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

/** Price a plan in the chosen currency. SOL needs a live quote; USDC is exact. */
export async function priceFor(plan: Plan, currency: PayCurrency): Promise<{ amount: number; baseUnits: number; quote?: SolQuote }> {
  const usd = plan.priceUsd ?? 0;
  if (currency === "USDC") {
    const baseUnits = Math.round(usd * 10 ** USDC_DECIMALS);
    return { amount: baseUnits / 10 ** USDC_DECIMALS, baseUnits };
  }
  const quote = await solUsd();
  if (!quote) throw new PaymentError("no_sol_price", "No SOL/USD price is available right now. Pay in USDC, or try again in a minute.", 503);
  // Round up to a micro-SOL so the chain amount is never below the USD price.
  const baseUnits = Math.ceil((usd / quote.usd) * LAMPORTS / 1000) * 1000;
  return { amount: baseUnits / LAMPORTS, baseUnits, quote };
}

export async function createIntent(account: Account, planId: PlanId, currency: PayCurrency, now = Date.now()): Promise<PaymentIntent> {
  if (!paymentsConnected()) throw new PaymentError("payments_off", "Payments are switched off.", 503);
  const plan = planById(planId);
  if (!plan.placeholder || !(plan.priceUsd && plan.priceUsd > 0)) throw new PaymentError("not_a_paid_plan", `${plan.name} is not a paid plan.`);
  const priced = await priceFor(plan, currency);
  const intent: PaymentIntent = {
    id: `pay_${randomBytes(8).toString("hex")}`,
    accountId: account.accountId,
    plan: plan.id,
    currency,
    amountUsd: plan.priceUsd,
    amount: priced.amount,
    baseUnits: priced.baseUnits,
    quote: priced.quote,
    to: protocolWallet.address,
    createdAt: now,
    expiresAt: now + INTENT_TTL_MS,
    status: "pending",
    source: "REAL",
  };
  await getStore().putDoc("payment", intent.id, intent, { at: now, key: account.accountId });
  return intent;
}

/**
 * The unsigned transaction for an intent, serialized for the buyer's wallet to sign and send.
 * SOL: one system transfer. USDC: create the destination token account if missing (idempotent,
 * buyer pays rent once), then a checked transfer. Both carry the intent id as a memo.
 */
export async function buildTransaction(intent: PaymentIntent, payer: string): Promise<{ transactionBase64: string; blockhash: string }> {
  const from = new PublicKey(payer);
  const to = new PublicKey(intent.to);
  const { url } = rpcUrl();
  const { blockhash } = await rpc<{ blockhash: string }>(url, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash });
  if (intent.currency === "SOL") {
    tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: intent.baseUnits }));
  } else {
    const mint = usdcMint();
    const src = ata(from, mint);
    const dst = ata(to, mint);
    tx.add(
      new TransactionInstruction({
        programId: ATA_PROGRAM,
        keys: [
          { pubkey: from, isSigner: true, isWritable: true },
          { pubkey: dst, isSigner: false, isWritable: true },
          { pubkey: to, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]), // CreateIdempotent
      }),
    );
    const data = Buffer.alloc(10);
    data.writeUInt8(12, 0); // TransferChecked
    data.writeBigUInt64LE(BigInt(intent.baseUnits), 1);
    data.writeUInt8(USDC_DECIMALS, 9);
    tx.add(
      new TransactionInstruction({
        programId: TOKEN_PROGRAM,
        keys: [
          { pubkey: src, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: dst, isSigner: false, isWritable: true },
          { pubkey: from, isSigner: true, isWritable: false },
        ],
        data,
      }),
    );
  }
  tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: from, isSigner: true, isWritable: false }], data: Buffer.from(`brain:${intent.id}`, "utf8") }));
  return { transactionBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), blockhash };
}

type ParsedInstruction = { programId?: string; program?: string; parsed?: unknown };
export interface ParsedPaymentTx {
  blockTime: number | null;
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[];
    postTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[];
    innerInstructions?: { instructions: ParsedInstruction[] }[];
  };
  transaction: { message: { accountKeys: ({ pubkey: string; signer?: boolean } | string)[]; instructions: ParsedInstruction[] } };
}

/**
 * Pure check of a parsed transaction against an intent. Exported for tests. Returns the payer.
 * Underpayment fails; overpayment is accepted (the buyer chose to send more).
 */
export function verifyParsedTx(intent: PaymentIntent, tx: ParsedPaymentTx | null, mint = usdcMint().toBase58()): { payer: string } {
  if (!tx) throw new PaymentError("tx_not_found", "That transaction is not confirmed yet.", 404);
  if (tx.meta.err) throw new PaymentError("tx_failed", "The transaction failed on chain. Nothing was charged.");
  if (tx.blockTime != null && tx.blockTime * 1000 < intent.createdAt - 120_000) throw new PaymentError("too_early", "That transaction predates this purchase.");
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? { pubkey: k, signer: false } : k));
  const payer = keys.find((k) => k.signer)?.pubkey ?? keys[0]?.pubkey;
  if (!payer) throw new PaymentError("bad_signature", "Unreadable transaction.");
  // Memo must name this intent: ties the payment to the account that created it.
  const all: ParsedInstruction[] = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions)];
  const memo = all.some((i) => (i.program === "spl-memo" || i.programId === MEMO_PROGRAM.toBase58()) && typeof i.parsed === "string" && i.parsed.includes(intent.id));
  if (!memo) throw new PaymentError("memo_missing", "The transaction does not reference this purchase.");
  const minUnits = Math.floor(intent.baseUnits * (1 - UNDERPAY_TOLERANCE));
  if (intent.currency === "SOL") {
    const i = keys.findIndex((k) => k.pubkey === intent.to);
    if (i < 0) throw new PaymentError("wrong_destination", "The transaction does not pay the protocol wallet.");
    const delta = tx.meta.postBalances[i] - tx.meta.preBalances[i];
    if (delta < minUnits) throw new PaymentError("underpaid", `The transfer was ${(delta / LAMPORTS).toFixed(6)} SOL; ${intent.amount} SOL was due.`);
  } else {
    const sum = (rows: NonNullable<ParsedPaymentTx["meta"]["preTokenBalances"]>) => rows.filter((r) => r.mint === mint && r.owner === intent.to).reduce((s, r) => s + Number(r.uiTokenAmount.amount), 0);
    const delta = sum(tx.meta.postTokenBalances ?? []) - sum(tx.meta.preTokenBalances ?? []);
    if (delta <= 0) throw new PaymentError("wrong_destination", "The transaction does not pay USDC to the protocol wallet.");
    if (delta < minUnits) throw new PaymentError("underpaid", `The transfer was ${(delta / 10 ** USDC_DECIMALS).toFixed(2)} USDC; ${intent.amount} USDC was due.`);
  }
  return { payer };
}

export async function getIntent(id: string) {
  return getStore().getDoc<PaymentIntent>("payment", id);
}

/**
 * Confirm a payment by signature. Reads the transaction from the chain, verifies it against the
 * intent, records the signature as spent, and returns the confirmed intent. The caller activates
 * the plan. Safe to call repeatedly: a confirmed intent is returned as is.
 */
export async function confirmIntent(account: Account, intentId: string, signature: string, now = Date.now()): Promise<PaymentIntent> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,120}$/.test(signature)) throw new PaymentError("bad_signature", "That does not look like a transaction signature.");
  const store = getStore();
  const intent = await getIntent(intentId);
  if (!intent || intent.accountId !== account.accountId) throw new PaymentError("intent_not_found", "Purchase not found.", 404);
  if (intent.status === "confirmed") return intent;
  if (now > intent.expiresAt + 10 * 60_000) throw new PaymentError("intent_expired", "This purchase expired. Start again; nothing was charged unless the transfer went through, in which case contact us with the signature.");
  return store.withLock(`payment:${signature}`, async () => {
    const used = await store.getDoc<{ intentId: string }>("payment", `sig:${signature}`);
    if (used && used.intentId !== intent.id) throw new PaymentError("signature_used", "That transaction has already been used for a purchase.", 409);
    const { url } = rpcUrl();
    const tx = await rpc<ParsedPaymentTx | null>(url, "getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    const { payer } = verifyParsedTx(intent, tx);
    const confirmed: PaymentIntent = { ...intent, status: "confirmed", signature, confirmedAt: now, payer };
    await store.putDoc("payment", `sig:${signature}`, { intentId: intent.id, accountId: account.accountId, at: now }, { at: now, key: `sig` });
    await store.putDoc("payment", intent.id, confirmed, { at: intent.createdAt, key: account.accountId });
    return confirmed;
  });
}

/** Confirmed purchases for an account, newest first. */
export async function paymentsFor(accountId: string, limit = 50) {
  return (await getStore().listDocs<PaymentIntent>("payment", { key: accountId, limit })).filter((p) => p.status === "confirmed");
}

export { PLAN_PERIOD_MS };
