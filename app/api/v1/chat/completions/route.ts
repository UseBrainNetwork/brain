import { randomBytes } from "node:crypto";
import { chatCompletionStream, validateChat } from "@/api/gateway";
import { body, nodeRoute } from "@/api/http";
import type { Priority } from "@/domain/economy";
import { placeOrder } from "@/engine/orders";
import { networkConfig } from "@/lib/config";
import { authenticate, customerRateLimit, openAccess, recordRequest } from "@/services/customers";
import { getReceipt } from "@/services/receipts";
import { bearer, json, tooMany } from "@/services/security";

export const dynamic = "force-dynamic";

const PRIORITIES: Record<string, Priority> = { cheap: "CHEAP", fast: "FAST", balanced: "BALANCED" };

/**
 * OpenAI-compatible: POST /v1/chat/completions (rewritten from /v1/*).
 * Extensions: `priority: "cheap" | "fast" | "balanced"` (BRAIN AUTO mode) and an `x-brain-receipt` header.
 * Non-streaming requests go through the compute market (order → route → execute → receipt);
 * streaming requests use the direct gateway path and are recorded without a receipt.
 */
export const POST = nodeRoute(async (req) => {
  const auth = await authenticate(bearer(req));
  if (!auth && !(await openAccess())) return json({ error: { code: "invalid_api_key", message: "Invalid or missing API key." } }, 401);
  const customer = auth?.customer ?? { customerId: "anonymous", label: "open access", createdAt: 0, rateLimit: networkConfig.rateLimit.inferenceRequests, source: "REAL" as const };
  if (!customerRateLimit(customer).ok) return tooMany();

  const raw = await body<Record<string, unknown>>(req, 128 * 1024);
  const chat = validateChat(raw);
  const priority = PRIORITIES[String(raw.priority ?? "balanced").toLowerCase()] ?? "BALANCED";
  const t0 = Date.now();

  if (chat.stream) {
    const out = await chatCompletionStream(chat);
    await recordRequest({ customerId: customer.customerId, at: t0, model: chat.model, endpoint: "chat.completions", route: { target: out.target === "CLOUD_FALLBACK" ? "CLOUD_GPU" : "EXTERNAL_PROVIDER", providerId: out.provider }, nodesUsed: [], inputUnits: 0, outputUnits: 0, cost: null, latencyMs: Date.now() - t0, receiptId: null, ok: true, source: "REAL" });
    return new Response(out.stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", "x-brain-target": out.target } });
  }

  const order = await placeOrder({ request: { kind: "chat", model: chat.model, messages: chat.messages, maxTokens: chat.max_tokens, temperature: chat.temperature }, priority }, customer.customerId);
  const receipt = order.receiptId ? await getReceipt(order.receiptId) : null;
  await recordRequest({
    customerId: customer.customerId,
    at: t0,
    model: chat.model,
    endpoint: "chat.completions",
    route: receipt?.route ? { target: receipt.route.target, providerId: receipt.route.providerId } : null,
    nodesUsed: receipt?.nodesUsed ?? [],
    inputUnits: 0,
    outputUnits: 0,
    cost: receipt?.customerCost?.amount ?? null,
    latencyMs: Date.now() - t0,
    receiptId: order.receiptId ?? null,
    ok: order.status === "COMPLETED",
    source: "REAL",
  });
  if (order.status !== "COMPLETED") {
    const status = order.status === "REJECTED" ? 503 : 502;
    return json({ error: { code: order.status === "REJECTED" ? "no_provider_available" : "upstream_failed", message: order.error ?? "execution failed" }, brain: { orderId: order.orderId, decisionId: order.decisionId } }, status);
  }
  return json(
    {
      id: `chatcmpl-${randomBytes(10).toString("hex")}`,
      object: "chat.completion",
      created: Math.floor(t0 / 1000),
      model: chat.model,
      choices: [{ index: 0, message: { role: "assistant", content: order.output ?? "" }, finish_reason: "stop" }],
      brain: { orderId: order.orderId, decisionId: order.decisionId, receiptId: order.receiptId, target: receipt?.route?.target, provider: receipt?.route?.providerId, latencyMs: Date.now() - t0, cost: receipt?.customerCost ?? null, verification: receipt?.verificationMethod },
    },
    { headers: { "x-brain-receipt": order.receiptId ?? "" } },
  );
}, networkConfig.rateLimit.inferenceRequests * 3);
