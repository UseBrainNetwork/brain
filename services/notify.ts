import type { RewardAllocation, RewardEpoch } from "@/domain/types";
import { fmtSol } from "@/lib/format";
import { siteUrl as configuredSiteUrl } from "@/lib/site";
import { hmac, hmacEqual } from "./security";
import { getStore } from "./store";

/**
 * Payout notifications. One email per wallet per settled epoch in which that wallet was allocated
 * something, sent through Resend. Entirely optional: no RESEND_API_KEY → nothing is sent, nothing
 * breaks. Emails come from Privy (email login) or are typed in; the wallet owner proves ownership
 * with the same link token the rest of wallet linking uses. Every email carries a one-click
 * unsubscribe. Nothing here affects what a wallet is owed.
 */

export interface WalletNotify {
  wallet: string;
  email: string;
  optIn: boolean;
  source: "privy" | "manual";
  at: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const validEmail = (s: unknown): s is string => typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s);

export const emailConfigured = () => Boolean(process.env.RESEND_API_KEY);
const fromAddress = () => process.env.BRAIN_EMAIL_FROM ?? "BRAIN <rewards@brainnetwork.app>";
const siteUrl = () => configuredSiteUrl.replace(/\/$/, "");

export async function getWalletNotify(wallet: string): Promise<WalletNotify | null> {
  return getStore().getDoc<WalletNotify>("notify", wallet);
}

export async function setWalletNotify(wallet: string, email: string, source: WalletNotify["source"]): Promise<WalletNotify> {
  const doc: WalletNotify = { wallet, email: email.trim().toLowerCase(), optIn: true, source, at: Date.now() };
  await getStore().putDoc("notify", wallet, doc, { at: doc.at, key: "on" });
  return doc;
}

export async function clearWalletNotify(wallet: string): Promise<void> {
  const cur = await getWalletNotify(wallet);
  if (!cur) return;
  const doc: WalletNotify = { ...cur, optIn: false, at: Date.now() };
  await getStore().putDoc("notify", wallet, doc, { at: doc.at, key: "off" });
}

/** Mask for display: j***@example.com */
export function maskEmail(e: string): string {
  const [user, domain] = e.split("@");
  if (!domain) return "***";
  return `${user.slice(0, 1)}***@${domain}`;
}

/* ---------------------------------------------------------------- unsubscribe tokens */

export function unsubscribeToken(wallet: string): string {
  return `${wallet}.${hmac(`unsub|${wallet}`)}`;
}

export function walletFromUnsubscribeToken(t: string): string | null {
  const [wallet, tag] = String(t).split(".");
  if (!wallet || !tag) return null;
  return hmacEqual(hmac(`unsub|${wallet}`), tag) ? wallet : null;
}

/* ---------------------------------------------------------------- sending */

interface Outgoing {
  from: string;
  to: string[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

async function sendBatch(emails: Outgoing[], idempotencyKey: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, status: 0, error: "unconfigured" };
  const res = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": idempotencyKey.slice(0, 256) },
    body: JSON.stringify(emails),
  });
  if (res.ok) return { ok: true, status: res.status };
  let error = res.statusText;
  try {
    const j = (await res.json()) as { message?: string };
    if (j.message) error = j.message;
  } catch {
    /* body not json */
  }
  return { ok: false, status: res.status, error };
}

function fmtEpoch(e: RewardEpoch): string {
  const d = new Date(e.startsAt);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${d.toISOString().slice(0, 10)} ${hh}:00 UTC`;
}

export function settledEmail(wallet: string, epoch: RewardEpoch, a: RewardAllocation): Omit<Outgoing, "from" | "to"> {
  const short = `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
  const unsub = `${siteUrl()}/api/wallet/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(wallet))}`;
  const text = [
    `Epoch ${fmtEpoch(epoch)} settled.`,
    ``,
    `Wallet ${short}`,
    `Allocated: ${fmtSol(a.lamports)}`,
    `Verified compute: ${a.verifiedCompute.toLocaleString("en-US")} units`,
    `Jobs completed: ${a.jobsCompleted.toLocaleString("en-US")}`,
    a.capped ? `Per-wallet cap applied this epoch.` : null,
    ``,
    `Pool this epoch: ${fmtSol(epoch.poolLamports)} · distributed ${fmtSol(epoch.distributedLamports)} across ${epoch.participants} wallet${epoch.participants === 1 ? "" : "s"}.`,
    ``,
    `Claim: ${siteUrl()}/rewards`,
    ``,
    `You get this because this wallet is linked to a BRAIN node and earned in this epoch. Payouts are for verified compute only; no return is promised.`,
    `Stop these emails: ${unsub}`,
  ]
    .filter((l) => l !== null)
    .join("\n");
  return {
    subject: `BRAIN · ${fmtSol(a.lamports)} allocated to ${short}`,
    text,
    headers: { "List-Unsubscribe": `<${unsub}>` },
  };
}

export interface NotifyResult {
  sent: number;
  skipped: "unconfigured" | "no_recipients" | null;
  error?: string;
}

/** Called once per settled live epoch. Idempotent per epoch through Resend's idempotency key. */
export async function notifySettled(epoch: RewardEpoch, allocations: RewardAllocation[]): Promise<NotifyResult> {
  if (!emailConfigured()) return { sent: 0, skipped: "unconfigured" };
  const from = fromAddress();
  const out: Outgoing[] = [];
  for (const a of allocations) {
    if (a.lamports <= 0) continue;
    const n = await getWalletNotify(a.wallet);
    if (!n || !n.optIn || !validEmail(n.email)) continue;
    out.push({ from, to: [n.email], ...settledEmail(a.wallet, epoch, a) });
  }
  if (out.length === 0) return { sent: 0, skipped: "no_recipients" };
  let sent = 0;
  let error: string | undefined;
  for (let i = 0; i < out.length; i += 100) {
    const chunk = out.slice(i, i + 100);
    const r = await sendBatch(chunk, `batch-epoch-settled/${epoch.id}/${i / 100}`);
    if (r.ok) sent += chunk.length;
    else error = r.error;
  }
  return { sent, skipped: null, error };
}
