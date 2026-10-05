import { randomBytes } from "node:crypto";
import { chatEventStream, sseHeaders } from "@/api/chatStream";
import { validateChat } from "@/api/gateway";
import { CHAT_SYSTEM_PROMPT } from "@/lib/chatSystem";
import { body, nodeRoute } from "@/api/http";
import type { PrivacyRequirement } from "@/domain/economy";
import { normalizeMode } from "@/domain/economy";
import { planById } from "@/lib/plans";
import { ensureAccount } from "@/services/accounts";
import { balance, consumeForReceipt, ensureMonthlyGrant, mayConsume } from "@/services/credits";
import { recordRequest } from "@/services/customers";
import { json, rateLimit } from "@/services/security";

export const dynamic = "force-dynamic";

const PRIVACY = new Set<PrivacyRequirement>(["PUBLIC", "STANDARD", "PRIVATE"]);

/**
 * Consumer chat endpoint for /chat. Authenticated by the account session cookie (created on first
 * use). Streams tokens, then the BRAIN run summary, and records credit consumption from the
 * receipt's real cost. Provider keys never leave the server.
 */
export const POST = nodeRoute(async (req) => {
  const { account, setCookie } = await ensureAccount(req);
  const plan = planById(account.plan);
  if (!rateLimit(`account:${account.accountId}`, plan.rateLimit).ok) return json({ error: { code: "rate_limited", message: `Your plan allows ${plan.rateLimit} requests per minute.` } }, 429);

  const raw = await body<Record<string, unknown>>(req, 128 * 1024);
  const chat = validateChat({ ...raw, stream: true });
  const mode = normalizeMode(String(raw.mode ?? "auto"));
  if (!plan.modes.includes(mode)) return json({ error: { code: "mode_not_in_plan", message: `${mode} routing is not included in the ${plan.name} plan.` } }, 403);
  const privacyRaw = String(raw.privacy ?? "standard").toUpperCase() as PrivacyRequirement;
  const privacy = PRIVACY.has(privacyRaw) ? privacyRaw : "STANDARD";
  if (privacy === "PRIVATE" && !plan.privateRouting) return json({ error: { code: "privacy_not_in_plan", message: `PRIVATE routing is not included in the ${plan.name} plan.` } }, 403);

  await ensureMonthlyGrant(account);
  const bal = await balance(account.accountId);
  if (!mayConsume(bal)) return json({ error: { code: "out_of_credits", message: "You have used this month's included credits." }, balance: bal.balance }, 402);

  const t0 = Date.now();
  const chatId = `chatcmpl-${randomBytes(10).toString("hex")}`;
  const messages = chat.messages[0]?.role === "system" ? chat.messages : [{ role: "system" as const, content: CHAT_SYSTEM_PROMPT }, ...chat.messages];
  const request = { kind: "chat" as const, model: chat.model, messages, maxTokens: chat.max_tokens, temperature: chat.temperature, privacy };
  const customerId = `acct:${account.accountId}`;

  const stream = await chatEventStream({
    input: { request, mode, privacy },
    customerId,
    chatId,
    t0,
    mode,
    privacy,
    onComplete: async (order, s) => {
      if (s.receipt) await consumeForReceipt(account, s.receipt, { orderId: order.orderId, inputUnits: s.brain.usage?.inputUnits, outputUnits: s.brain.usage?.outputUnits });
      await recordRequest({
        customerId,
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
    },
  });
  const headers: Record<string, string> = { ...sseHeaders };
  if (setCookie) headers["set-cookie"] = setCookie;
  return new Response(stream, { headers });
}, 60);
