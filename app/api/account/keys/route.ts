import { body, nodeRoute } from "@/api/http";
import { ensureAccount } from "@/services/accounts";
import { createAccountKey, listAccountKeys, publicKey, revokeAccountKey } from "@/services/accountKeys";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

/** Keys for the signed-in account. The secret is returned once, on creation, and never stored. */
export const GET = nodeRoute(async (req) => {
  const { account, setCookie } = await ensureAccount(req);
  const keys = (await listAccountKeys(account)).map(publicKey);
  const res = json({ keys });
  if (setCookie) res.headers.set("set-cookie", setCookie);
  res.headers.set("cache-control", "no-store");
  return res;
}, 60);

export const POST = nodeRoute(async (req) => {
  const { account, setCookie } = await ensureAccount(req);
  try {
    const { key, secret } = await createAccountKey(account);
    const res = json({ key: publicKey(key), secret }, 201);
    if (setCookie) res.headers.set("set-cookie", setCookie);
    return res;
  } catch (e) {
    return json({ error: { code: "key_limit", message: e instanceof Error ? e.message : "cannot create key" } }, 409);
  }
}, 10);

export const DELETE = nodeRoute(async (req) => {
  const { account } = await ensureAccount(req);
  const { keyId } = await body<{ keyId?: string }>(req);
  if (!keyId) return json({ error: { code: "bad_request", message: "keyId required" } }, 400);
  const ok = await revokeAccountKey(account, keyId);
  return ok ? json({ ok: true }) : json({ error: { code: "not_found", message: "no such key on this account" } }, 404);
}, 20);
