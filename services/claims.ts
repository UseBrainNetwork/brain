import type { PayoutStatus, RewardClaim } from "@/domain/types";
import { networkConfig } from "@/lib/config";
import { NodeError } from "./nodes";
import { parseSecretKey, solanaPayoutSender, type PayoutSender } from "./payouts";
import { LAMPORTS_PER_SOL } from "./settlement";
import { getStore } from "./store";
import { hmac, hmacEqual, token } from "./security";
import { verifyEd25519 } from "./wallet";

const DAY_MS = 24 * 60 * 60_000;

const g = globalThis as typeof globalThis & { __brainPayoutSender?: PayoutSender | null };

const solEnv = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Math.floor((v > 0 ? v : fallback) * LAMPORTS_PER_SOL);
};
export const maxClaimLamports = () => solEnv("BRAIN_PAYOUT_MAX_SOL", 5);
export const dailyCapLamports = () => solEnv("BRAIN_PAYOUT_DAILY_MAX_SOL", 50);

/** Payouts require an explicit kill-switch, an RPC and a valid key. Anything missing = disabled. */
export function payoutStatus(): PayoutStatus {
  const base = {
    asset: "SOL" as const,
    minLamports: networkConfig.rewards.minClaimLamports,
    maxLamports: maxClaimLamports(),
    cluster: process.env.BRAIN_SOLANA_CLUSTER ?? "mainnet-beta",
  };
  if (process.env.BRAIN_PAYOUTS_ENABLED !== "true") return { ...base, enabled: false, reason: "Payouts open once the protocol payout wallet is connected." };
  if (!process.env.SOLANA_RPC_URL || !process.env.BRAIN_PAYOUT_SECRET_KEY) return { ...base, enabled: false, reason: "Payout wallet is not configured." };
  const sender = getSender();
  if (!sender) return { ...base, enabled: false, reason: "Payout wallet key is invalid." };
  return { ...base, enabled: true, wallet: sender.address };
}

function getSender(): PayoutSender | null {
  if (g.__brainPayoutSender !== undefined) return g.__brainPayoutSender;
  try {
    g.__brainPayoutSender = solanaPayoutSender(process.env.SOLANA_RPC_URL!, parseSecretKey(process.env.BRAIN_PAYOUT_SECRET_KEY!));
  } catch {
    g.__brainPayoutSender = null;
  }
  return g.__brainPayoutSender;
}

/** Tests inject a fake sender here. */
export function setPayoutSender(s: PayoutSender | null | undefined) {
  g.__brainPayoutSender = s;
}

export async function balanceOf(wallet: string) {
  const store = getStore();
  const [allocations, claims] = await Promise.all([store.allocationsForWallet(wallet), store.claimsForWallet(wallet)]);
  const earned = allocations.filter((a) => a.provenance === "live").reduce((s, a) => s + a.lamports, 0);
  const demo = allocations.filter((a) => a.provenance !== "live").reduce((s, a) => s + a.lamports, 0);
  const claimed = claims.filter((c) => c.status !== "failed").reduce((s, c) => s + c.lamports, 0);
  return { earned, demo, claimed, claimable: Math.max(0, earned - claimed), claims };
}

const fmtSol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(9).replace(/0+$/, "").replace(/\.$/, "");

const mac = (wallet: string, lamports: number, nonce: string, exp: number) => hmac(`claim|${wallet}|${lamports}|${nonce}|${exp}`);

/** The exact text the wallet signs. Every field is bound by the HMAC; the signature binds it to the wallet. */
export async function issueClaim(wallet: string) {
  const status = payoutStatus();
  if (!status.enabled) throw new NodeError("payouts_disabled", 503);
  const { claimable } = await balanceOf(wallet);
  const lamports = Math.min(claimable, status.maxLamports);
  if (lamports < status.minLamports) throw new NodeError("nothing_to_claim", 409);
  const nonce = token(16);
  const exp = Date.now() + networkConfig.rewards.claimTtlMs;
  const message = [
    "BRAIN reward claim",
    "",
    `Wallet: ${wallet}`,
    `Amount: ${fmtSol(lamports)} SOL`,
    `Lamports: ${lamports}`,
    `Claim: ${nonce}.${mac(wallet, lamports, nonce, exp)}`,
    `Expires: ${new Date(exp).toISOString()}`,
    "",
    "Signing authorizes a payout of your earned rewards to this wallet. It costs nothing and moves no funds from it.",
  ].join("\n");
  return { message, lamports };
}

function parseClaim(wallet: string, message: string) {
  const field = (k: string) => message.match(new RegExp(`^${k}: (.+)$`, "m"))?.[1]?.trim();
  if (!message.startsWith("BRAIN reward claim\n") || field("Wallet") !== wallet) return null;
  const lamports = Number(field("Lamports"));
  const [nonce, tag] = (field("Claim") ?? "").split(".");
  const exp = Date.parse(field("Expires") ?? "");
  if (!Number.isSafeInteger(lamports) || lamports <= 0 || !nonce || !tag || !Number.isFinite(exp)) return null;
  if (!hmacEqual(mac(wallet, lamports, nonce, exp), tag)) return null;
  return { lamports, nonce, exp };
}

export async function claim(wallet: string, message: string, signatureB64: string): Promise<RewardClaim> {
  const status = payoutStatus();
  const sender = getSender();
  if (!status.enabled || !sender) throw new NodeError("payouts_disabled", 503);
  const parsed = parseClaim(wallet, message);
  if (!parsed) throw new NodeError("invalid_claim", 400);
  if (parsed.exp < Date.now()) throw new NodeError("claim_expired", 410);
  if (!verifyEd25519(wallet, message, signatureB64)) throw new NodeError("bad_signature", 401);
  if (parsed.lamports > status.maxLamports || parsed.lamports < status.minLamports) throw new NodeError("amount_out_of_range", 400);
  if (wallet === sender.address) throw new NodeError("invalid_recipient", 400);

  const store = getStore();
  const now = Date.now();
  if ((await store.claimedSince(now - DAY_MS)) + parsed.lamports > dailyCapLamports()) throw new NodeError("daily_payout_cap", 503);
  const pending: RewardClaim = { id: parsed.nonce, wallet, lamports: parsed.lamports, status: "pending", createdAt: now, updatedAt: now };
  // One pending claim per wallet and one use per nonce, enforced by the store.
  if (!(await store.insertClaim(pending))) throw new NodeError("claim_in_progress", 409);

  // Re-check with this claim counted: closes the race between two claims signed against the same balance.
  const { earned, claimed } = await balanceOf(wallet);
  if (claimed > earned) {
    const failed = { ...pending, status: "failed" as const, error: "insufficient_balance", updatedAt: Date.now() };
    await store.updateClaim(failed);
    throw new NodeError("insufficient_balance", 409);
  }

  let txSignature: string;
  try {
    txSignature = await sender.send(wallet, parsed.lamports);
  } catch (e) {
    const failed = { ...pending, status: "failed" as const, error: e instanceof Error ? e.message.slice(0, 200) : "send_failed", updatedAt: Date.now() };
    await store.updateClaim(failed);
    return failed;
  }
  const sent: RewardClaim = { ...pending, status: "sent", txSignature, updatedAt: Date.now() };
  await store.updateClaim(sent);
  return sent;
}

/**
 * Advances sent claims to confirmed/failed from chain state. A claim with no on-chain record
 * after the blockhash validity window (~2 min) can never land, so it fails and the balance returns.
 */
export async function refreshClaims(wallet: string): Promise<RewardClaim[]> {
  const store = getStore();
  const claims = await store.claimsForWallet(wallet);
  const sender = getSender();
  if (!sender) return claims;
  const out: RewardClaim[] = [];
  for (const c of claims) {
    if (c.status !== "sent" || !c.txSignature) {
      out.push(c);
      continue;
    }
    const s = await sender.status(c.txSignature).catch(() => "rpc_error" as const);
    let next = c;
    if (s === "rpc_error") {
      out.push(c);
      continue;
    }
    if (s === "confirmed") next = { ...c, status: "confirmed", updatedAt: Date.now() };
    else if (s === "failed") next = { ...c, status: "failed", error: "transaction_failed", updatedAt: Date.now() };
    else if (Date.now() - c.updatedAt > 5 * 60_000) next = { ...c, status: "failed", error: "not_landed", updatedAt: Date.now() };
    if (next !== c) await store.updateClaim(next);
    out.push(next);
  }
  return out;
}
