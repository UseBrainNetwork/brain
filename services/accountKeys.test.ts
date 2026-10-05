import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./store";
import { createAccount } from "./accounts";
import { accountCustomerId, createAccountKey, listAccountKeys, MAX_KEYS_PER_ACCOUNT, publicKey, revokeAccountKey } from "./accountKeys";
import { authenticate } from "./customers";

vi.mock("server-only", () => ({}));

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };

describe("account API keys", () => {
  beforeEach(() => {
    g.__brainStore = new MemoryStore();
  });

  it("issues a key that authenticates as the account's customer, and never exposes the hash", async () => {
    const a = await createAccount();
    const { key, secret } = await createAccountKey(a);
    expect(secret.startsWith("brain_sk_")).toBe(true);
    expect(key.customerId).toBe(accountCustomerId(a));
    const auth = await authenticate(secret);
    expect(auth?.customer.customerId).toBe(`acct:${a.accountId}`);
    expect(Object.keys(publicKey(key))).not.toContain("keyHash");
    expect(JSON.stringify(publicKey(key))).not.toContain(secret);
  });

  it("lists only this account's keys and refuses to revoke another account's key", async () => {
    const a = await createAccount();
    const b = await createAccount();
    const ka = await createAccountKey(a);
    const kb = await createAccountKey(b);
    expect((await listAccountKeys(a)).map((k) => k.keyId)).toEqual([ka.key.keyId]);
    expect(await revokeAccountKey(a, kb.key.keyId)).toBe(false);
    expect(await authenticate(kb.secret)).not.toBeNull();
    expect(await revokeAccountKey(a, ka.key.keyId)).toBe(true);
    expect(await authenticate(ka.secret)).toBeNull();
  });

  it("caps active keys per account", async () => {
    const a = await createAccount();
    for (let i = 0; i < MAX_KEYS_PER_ACCOUNT; i++) await createAccountKey(a);
    await expect(createAccountKey(a)).rejects.toThrow(/limit/);
  });
});
