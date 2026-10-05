import { body, nodeRoute } from "@/api/http";
import { createCustomer } from "@/services/customers";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

/** Operator-only: create a customer and its first API key. Requires BRAIN_ADMIN_TOKEN. */
export const POST = nodeRoute(async (req) => {
  const token = process.env.BRAIN_ADMIN_TOKEN;
  if (!token || req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
  const b = await body<{ label?: string; rateLimit?: number }>(req);
  const { customer, key, secret } = await createCustomer(String(b.label ?? "customer"), Number(b.rateLimit) > 0 ? Number(b.rateLimit) : 60);
  // The secret is returned exactly once.
  return json({ customer, key: { keyId: key.keyId, prefix: key.prefix }, secret }, 201);
}, 10);
