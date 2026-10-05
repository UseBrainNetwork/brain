import { randomBytes } from "node:crypto";
import { chatEventStream, sseHeaders, summarize } from "@/api/chatStream";
import { validateChat } from "@/api/gateway";
import { body, nodeRoute } from "@/api/http";
import type { ComputeOrder, PrivacyRequirement } from "@/domain/economy";
import { normalizeMode } from "@/domain/economy";
import { placeOrder } from "@/engine/orders";
import { networkConfig } from "@/lib/config";
import { getAccount } from "@/services/accounts";
import { balance, consumeForReceipt, ensureMonthlyGrant, mayConsume } from "@/services/credits";
import { authenticate, customerRateLimit, openAccess, recordRequest } from "@/services/customers";
import { planById } from "@/lib/plans";
import { bearer, json, tooMany } from "@/services/security";

export const dynamic = "force-dynamic";

const PRIVACY = new Set<PrivacyRequirement>(["PUBLIC", "STANDARD", "PRIVATE"]);

/**
 * OpenAI-compatible: POST /v1/chat/completions (rewritten from /v1/*).
 *
 * Extensions:
 *   mode: "auto" | "cheap" | "fast" | "quality" | "browser_only"   (BRAIN AUTO routing; `priority` accepted as an alias)
 *   privacy: "public" | "standard" | "private"
 *   Response carries a `brain` object (route, model, cost, latency, verification, receipt id) and an `x-brain-receipt` header.
 *   Streaming responses emit the same object as a final `event: brain` SSE message after the last token.
 *
 * Both paths go through BRAIN AUTO: order → classify → plan → estimate → select → execute → receipt.
 */
export const POST = nodeRoute(async (req) => {
  const auth = await authenticate(bearer(req));
  if (!auth && !(await openAccess())) return json({ error: { code: "invalid_api_key", message: "Invalid or missing API key." } }, 401);
  const customer = auth?.customer ?? { customerId: "anonymous", label: "open access", createdAt: 0, rateLimit: networkConfig.rateLimit.inferenceRequests, source: "REAL" as const };
  if (!customerRateLimit(customer).ok) return tooMany();

  // Keys issued from /account map to `acct:<id>` and share that account's plan and credit ledger.
  const account = customer.customerId.startsWith("acct:") ? await getAccount(customer.customerId.slice(5)) : null;

  const raw = await body<Record<string, unknown>>(req, 128 * 1024);
  const chat = validateChat(raw);
  const mode = normalizeMode(String(raw.mode ?? raw.priority ?? "auto"));
  const privacyRaw = String(raw.privacy ?? "standard").toUpperCase() as PrivacyRequirement;
  const privacy = PRIVACY.has(privacyRaw) ? privacyRaw : "STANDARD";
  if (account) {
    const plan = planById(account.plan);
    if (!plan.modes.includes(mode)) return json({ error: { code: "mode_not_in_plan", message: `${mode} routing is not included in the ${plan.name} plan.` } }, 403);
    if (privacy === "PRIVATE" && !plan.privateRouting) return json({ error: { code: "privacy_not_in_plan", message: `PRIVATE routing is not included in the ${plan.name} plan.` } }, 403);
    await ensureMonthlyGrant(account);
    const bal = await balance(account.accountId);
    if (!mayConsume(bal)) return json({ error: { code: "out_of_credits", message: "This account has used its included credits for the month." } }, 402);
  }
  const t0 = Date.now();
  const chatId = `chatcmpl-${randomBytes(10).toString("hex")}`;
  const request = { kind: "chat" as const, model: chat.model, messages: chat.messages, maxTokens: chat.max_tokens, temperature: chat.temperature, privacy, tools: chat.tools, tool_choice: chat.tool_choice, response_format: chat.response_format, stop: chat.stop };

  const record = async (order: ComputeOrder, s: Awaited<ReturnType<typeof summarize>>) => {
    if (account && s.receipt) await consumeForReceipt(account, s.receipt, { orderId: order.orderId, inputUnits: s.brain.usage?.inputUnits, outputUnits: s.brain.usage?.outputUnits });
    await recordRequest({
      customerId: customer.customerId,
      at: t0,
      model: chat.model,
      endpoint: "chat.completions",
      route: s.receipt?.route ? { target: s.receipt.route.target, providerId: s.receipt.route.providerId } : null,
      nodesUsed: s.receipt?.nodesUsed ?? [],
      inputUnits: 0,
      outputUnits: 0,
      cost: s.receipt?.customerCost?.amount ?? null,
      latencyMs: Date.now() - t0,
      receiptId: order.receiptId ?? null,
      ok: order.status === "COMPLETED",
      source: "REAL",
    });
  };

  if (chat.stream) {
    const stream = await chatEventStream({ input: { request, mode, privacy }, customerId: customer.customerId, chatId, t0, mode, privacy, onComplete: record });
    return new Response(stream, { headers: sseHeaders });
  }

  const order = await placeOrder({ request, mode, privacy }, customer.customerId);
  const s = await summarize(order, t0, mode, privacy);
  await record(order, s);
  if (order.status !== "COMPLETED") {
    const status = order.status === "REJECTED" ? 503 : 502;
    return json({ error: { code: order.status === "REJECTED" ? "no_provider_available" : "upstream_failed", message: order.error ?? "execution failed" }, brain: s.brain }, status);
  }
  return json(
    {
      id: chatId,
      object: "chat.completion",
      created: Math.floor(t0 / 1000),
      model: chat.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: order.toolCalls?.length && !order.output ? null : (order.output ?? ""), ...(order.toolCalls?.length ? { tool_calls: order.toolCalls } : {}) },
          finish_reason: order.finishReason ?? (order.toolCalls?.length ? "tool_calls" : "stop"),
        },
      ],
      brain: s.brain,
    },
    { headers: { "x-brain-receipt": order.receiptId ?? "" } },
  );
}, networkConfig.rateLimit.inferenceRequests * 3);
