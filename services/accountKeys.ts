import "server-only";
import type { ApiKey, Customer } from "@/domain/economy";
import { planById } from "@/lib/plans";
import type { Account } from "./accounts";
import { issueKey } from "./customers";
import { getStore } from "./store";

/**
 * Self-serve API keys for consumer accounts. A key maps to the customer id `acct:<accountId>`,
 * the same id the /chat endpoint uses, so API usage and chat usage share one credit ledger.
 */

export const accountCustomerId = (a: Account) => `acct:${a.accountId}`;

export async function ensureAccountCustomer(a: Account): Promise<Customer> {
  const store = getStore();
  const id = accountCustomerId(a);
  const existing = await store.getDoc<Customer>("customer", id);
  if (existing) return existing;
  const plan = planById(a.plan);
  const customer: Customer = { customerId: id, label: `account ${a.accountId}`, createdAt: Date.now(), rateLimit: plan.rateLimit, source: "REAL" };
  await store.putDoc("customer", id, customer, { at: customer.createdAt });
  return customer;
}

export async function listAccountKeys(a: Account): Promise<ApiKey[]> {
  const id = accountCustomerId(a);
  const all = await getStore().listDocs<ApiKey>("apikey", { limit: 5000 });
  return all.filter((k) => k.customerId === id).sort((x, y) => y.createdAt - x.createdAt);
}

export const MAX_KEYS_PER_ACCOUNT = 5;

export async function createAccountKey(a: Account): Promise<{ key: ApiKey; secret: string }> {
  await ensureAccountCustomer(a);
  const active = (await listAccountKeys(a)).filter((k) => !k.revokedAt);
  if (active.length >= MAX_KEYS_PER_ACCOUNT) throw new Error(`limit of ${MAX_KEYS_PER_ACCOUNT} active keys`);
  return issueKey(accountCustomerId(a));
}

export async function revokeAccountKey(a: Account, keyId: string): Promise<boolean> {
  const store = getStore();
  const k = await store.getDoc<ApiKey>("apikey", keyId);
  if (!k || k.customerId !== accountCustomerId(a)) return false;
  k.revokedAt = Date.now();
  await store.putDoc("apikey", k.keyId, k, { at: k.createdAt, key: `revoked:${k.keyHash}` });
  return true;
}

/** Public shape: never includes the hash. */
export const publicKey = (k: ApiKey) => ({ keyId: k.keyId, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt ?? null, revokedAt: k.revokedAt ?? null });
