import { randomBytes } from "node:crypto";
import type { ApiKey, Customer, CustomerRequestRecord } from "@/domain/economy";
import { sha256 } from "./receipts";
import { rateLimit } from "./security";
import { getStore } from "./store";

/**
 * Customers and API keys — the minimum needed to attribute usage and cost. Secrets are shown
 * once at creation and only their sha256 is stored. Not a billing system.
 */

export async function createCustomer(label: string, rateLimitPerMin = 60): Promise<{ customer: Customer; key: ApiKey; secret: string }> {
  const store = getStore();
  const customer: Customer = { customerId: `cus_${randomBytes(6).toString("hex")}`, label: label.slice(0, 80), createdAt: Date.now(), rateLimit: rateLimitPerMin, source: "REAL" };
  await store.putDoc("customer", customer.customerId, customer, { at: customer.createdAt });
  const { key, secret } = await issueKey(customer.customerId);
  return { customer, key, secret };
}

export async function issueKey(customerId: string): Promise<{ key: ApiKey; secret: string }> {
  const secret = `brain_sk_${randomBytes(24).toString("base64url")}`;
  const key: ApiKey = { keyId: `key_${randomBytes(5).toString("hex")}`, customerId, keyHash: sha256(secret), prefix: secret.slice(0, 14), createdAt: Date.now() };
  await getStore().putDoc("apikey", key.keyId, key, { at: key.createdAt, key: key.keyHash });
  return { key, secret };
}

export async function revokeKey(keyId: string) {
  const store = getStore();
  const k = await store.getDoc<ApiKey>("apikey", keyId);
  if (!k) return false;
  k.revokedAt = Date.now();
  await store.putDoc("apikey", k.keyId, k, { at: k.createdAt, key: `revoked:${k.keyHash}` });
  return true;
}

/** Resolves a bearer secret to its customer, or null. Legacy BRAIN_API_KEYS map to the "legacy" customer. */
export async function authenticate(secret: string | null): Promise<{ customer: Customer; key?: ApiKey } | null> {
  if (!secret) return null;
  const store = getStore();
  const key = await store.findDocByKey<ApiKey>("apikey", sha256(secret));
  if (key && !key.revokedAt) {
    const customer = await store.getDoc<Customer>("customer", key.customerId);
    if (customer) {
      key.lastUsedAt = Date.now();
      void store.putDoc("apikey", key.keyId, key, { at: key.createdAt, key: key.keyHash });
      return { customer, key };
    }
  }
  const legacy = (process.env.BRAIN_API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (legacy.includes(secret)) return { customer: { customerId: "legacy", label: "BRAIN_API_KEYS", createdAt: 0, rateLimit: 60, source: "REAL" } };
  return null;
}

/**
 * Anonymous /v1 access is closed. Every request must carry a key from /account (Free plan included),
 * so usage is always bound to a plan and a credit ledger. Set BRAIN_OPEN_V1=1 for a local open demo.
 */
export async function openAccess(): Promise<boolean> {
  return process.env.BRAIN_OPEN_V1 === "1";
}

export const MISSING_KEY = { code: "invalid_api_key", message: "Missing or invalid API key. Create one under Account → API keys at https://brainnetwork.app/account (free plan included) and send it as Authorization: Bearer <key>." };

export function customerRateLimit(c: Customer) {
  return rateLimit(`customer:${c.customerId}`, c.rateLimit);
}

export async function recordRequest(r: Omit<CustomerRequestRecord, "id">) {
  const row: CustomerRequestRecord = { id: `rq_${randomBytes(6).toString("hex")}`, ...r };
  await getStore().putDoc("request", row.id, row, { at: row.at, key: row.customerId });
  return row;
}

export async function usage(customerId: string, limit = 100) {
  const rows = await getStore().listDocs<CustomerRequestRecord>("request", { key: customerId, limit });
  const cost = rows.filter((r) => r.cost != null);
  return {
    requests: rows.length,
    ok: rows.filter((r) => r.ok).length,
    inputUnits: rows.reduce((s, r) => s + r.inputUnits, 0),
    outputUnits: rows.reduce((s, r) => s + r.outputUnits, 0),
    /** null when no request carried a price. */
    cost: cost.length ? cost.reduce((s, r) => s + (r.cost ?? 0), 0) : null,
    history: rows,
  };
}

export async function listRequests(limit = 50) {
  return getStore().listDocs<CustomerRequestRecord>("request", { limit });
}
