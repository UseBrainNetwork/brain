import { nodeRoute } from "@/api/http";
import { authenticate, usage } from "@/services/customers";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

/** GET /v1/usage — the caller's request history and cost (null when unpriced). */
export const GET = nodeRoute(async (req) => {
  const auth = await authenticate(bearer(req));
  if (!auth) return json({ error: { code: "invalid_api_key", message: "Invalid or missing API key." } }, 401);
  return json({ customer: { id: auth.customer.customerId, label: auth.customer.label }, ...(await usage(auth.customer.customerId)) });
});
