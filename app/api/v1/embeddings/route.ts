import { body, nodeRoute } from "@/api/http";
import { networkConfig } from "@/lib/config";
import { authenticate, customerRateLimit, openAccess, recordRequest } from "@/services/customers";
import { bearer, json, tooMany } from "@/services/security";

export const dynamic = "force-dynamic";

/**
 * OpenAI-compatible: POST /v1/embeddings. Passthrough to the configured external provider's
 * embeddings endpoint (BRAIN_EXTERNAL_BASE_URL + BRAIN_EXTERNAL_EMBED_MODEL). The browser network
 * has no embedding kernel yet, so this never claims to run on it. 503 when unconfigured.
 */
export const POST = nodeRoute(async (req) => {
  const auth = await authenticate(bearer(req));
  if (!auth && !(await openAccess())) return json({ error: { code: "invalid_api_key", message: "Invalid or missing API key." } }, 401);
  const customer = auth?.customer ?? { customerId: "anonymous", label: "open access", createdAt: 0, rateLimit: networkConfig.rateLimit.inferenceRequests, source: "REAL" as const };
  if (!customerRateLimit(customer).ok) return tooMany();

  const base = process.env.BRAIN_EXTERNAL_BASE_URL;
  const key = process.env.BRAIN_EXTERNAL_API_KEY;
  const model = process.env.BRAIN_EXTERNAL_EMBED_MODEL;
  if (!base || !key || !model) return json({ error: { code: "no_provider_available", message: "Embeddings are not configured on this server (BRAIN_EXTERNAL_EMBED_MODEL)." } }, 503);

  const b = await body<{ input?: unknown }>(req, 256 * 1024);
  const input = Array.isArray(b.input) ? b.input.slice(0, 64) : typeof b.input === "string" ? [b.input] : null;
  if (!input || input.some((x) => typeof x !== "string")) return json({ error: { code: "invalid_request", message: "input must be a string or array of strings." } }, 400);
  const t0 = Date.now();
  const r = await fetch(`${base.replace(/\/$/, "")}/embeddings`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model, input }) });
  const ok = r.ok;
  const j = ok ? await r.json() : null;
  await recordRequest({ customerId: customer.customerId, at: t0, model: "brain/embed", endpoint: "embeddings", route: { target: "EXTERNAL_PROVIDER", providerId: "external" }, nodesUsed: [], inputUnits: j?.usage?.prompt_tokens ?? 0, outputUnits: 0, cost: null, latencyMs: Date.now() - t0, receiptId: null, ok, source: "REAL" });
  if (!ok) return json({ error: { code: "upstream_failed", message: `upstream ${r.status}` } }, 502);
  return json({ object: "list", model: "brain/embed", data: j.data, usage: j.usage, brain: { target: "EXTERNAL_PROVIDER", provider: "external", verification: "unverified-provider-response" } });
}, networkConfig.rateLimit.inferenceRequests * 3);
