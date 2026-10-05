import { randomBytes } from "node:crypto";
import type { Source } from "@/domain/economy";
import { type PlanId, planById } from "@/lib/plans";
import { hmac, hmacEqual } from "./security";
import { getStore } from "./store";

/**
 * Consumer accounts, deliberately minimal. An account is created on first use and identified by
 * a signed, httpOnly cookie. No passwords, no email. A wallet can be attached by signature (the
 * same proof contributors already use), which links the account to the nodes that wallet powers.
 *
 * This is enough to attribute credits, usage and compute earnings to one person across /chat,
 * /account and /earn. It is not an identity system and does not pretend to be.
 */
export interface Account {
  accountId: string;
  createdAt: number;
  lastSeenAt: number;
  plan: PlanId;
  /** Solana address proven by signature, if attached. */
  wallet?: string;
  /** API customer this account owns (created lazily when the first key is issued). */
  customerId?: string;
  source: Source;
}

export const SESSION_COOKIE = "brain_session";
const SESSION_TTL_MS = 180 * 24 * 3600_000;

export function signSession(accountId: string, exp = Date.now() + SESSION_TTL_MS) {
  return `${accountId}.${exp}.${hmac(`session|${accountId}|${exp}`)}`;
}

export function verifySession(cookie: string | undefined | null): string | null {
  if (!cookie) return null;
  const [accountId, expStr, tag] = cookie.split(".");
  const exp = Number(expStr);
  if (!accountId || !tag || !(exp > Date.now()) || !/^acc_[0-9a-f]{12}$/.test(accountId)) return null;
  return hmacEqual(hmac(`session|${accountId}|${exp}`), tag) ? accountId : null;
}

export function readSessionCookie(req: Request): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionSetCookie(accountId: string) {
  const exp = Date.now() + SESSION_TTL_MS;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(signSession(accountId, exp))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

export async function getAccount(accountId: string) {
  return getStore().getDoc<Account>("account", accountId);
}

export async function saveAccount(a: Account) {
  await getStore().putDoc("account", a.accountId, a, { at: a.createdAt, key: a.wallet ? `wallet:${a.wallet}` : undefined });
}

export async function createAccount(): Promise<Account> {
  const a: Account = { accountId: `acc_${randomBytes(6).toString("hex")}`, createdAt: Date.now(), lastSeenAt: Date.now(), plan: "FREE", source: "REAL" };
  await saveAccount(a);
  return a;
}

/** Resolve the account for a request without creating one. */
export async function currentAccount(req: Request): Promise<Account | null> {
  const id = verifySession(readSessionCookie(req));
  return id ? getAccount(id) : null;
}

/** Resolve or create the account for a request. Returns the Set-Cookie header when a new session was started. */
export async function ensureAccount(req: Request): Promise<{ account: Account; setCookie: string | null }> {
  const existing = await currentAccount(req);
  if (existing) {
    if (Date.now() - existing.lastSeenAt > 60_000) {
      existing.lastSeenAt = Date.now();
      void saveAccount(existing);
    }
    return { account: existing, setCookie: null };
  }
  const account = await createAccount();
  return { account, setCookie: sessionSetCookie(account.accountId) };
}

export async function accountForWallet(wallet: string) {
  return getStore().findDocByKey<Account>("account", `wallet:${wallet}`);
}

/** Attach a signature-verified wallet. Callers must have verified the signature first. */
export async function attachWallet(account: Account, wallet: string) {
  account.wallet = wallet;
  await saveAccount(account);
  return account;
}

export async function setPlan(account: Account, plan: PlanId) {
  account.plan = planById(plan).id;
  await saveAccount(account);
  return account;
}
