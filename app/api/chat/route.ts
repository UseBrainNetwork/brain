import { randomBytes } from "node:crypto";
import { chatEventStream, sseHeaders } from "@/api/chatStream";
import { validateChat } from "@/api/gateway";
import { networkChatStream } from "@/api/networkChatStream";
import { CHAT_SYSTEM_PROMPT, NETWORK_SYSTEM_PROMPT } from "@/lib/chatSystem";
import { body, nodeRoute } from "@/api/http";
import type { PrivacyRequirement } from "@/domain/economy";
import { normalizeMode } from "@/domain/economy";
import { withTimeout } from "@/lib/async";
import { communityFirstFor, planById } from "@/lib/plans";
import { isAllowedModel } from "@/node/models";
import { ensureAccount } from "@/services/accounts";
import { balance, consumeForReceipt, ensureMonthlyGrant, mayConsume } from "@/services/credits";
import { recordRequest } from "@/services/customers";
import { json, rateLimit } from "@/services/security";

export const dynamic = "force-dynamic";
/** NETWORK mode speed depends on the nodes online; the budget covers a slow pipeline and a long answer. */
export const maxDuration = 300;

const PRIVACY = new Set<PrivacyRequirement>(["PUBLIC", "STANDARD", "PRIVATE"]);
/** Max store time spent on account + credit bookkeeping, in total, before the request proceeds without it. */
const STORE_BUDGET_MS = 3_500;

/**
 * Consumer chat endpoint for /chat. Authenticated by the account session cookie (created on first
 * use). Streams tokens, then the BRAIN run summary, and records credit consumption from the
 * receipt's real cost. Provider keys never leave the server.
 */
export const POST = nodeRoute(async (req, { ip }) => {
  // Account and credit bookkeeping are bounded: if the store is slow the answer still streams,
  // with no credit charged and no plan upgrade granted (free-plan limits apply).
  // One budget covers the whole chain (account → monthly grant → balance) so a slow store costs at
  // most STORE_BUDGET_MS before the first token, not one budget per step.
  const budgetStart = Date.now();
  const remaining = () => Math.max(250, STORE_BUDGET_MS - (Date.now() - budgetStart));
  const session = await withTimeout(
    ensureAccount(req).catch(() => null),
    remaining(),
    null,
  );
  const degraded = session == null;
  if (degraded) console.warn("[chat] account store slow; streaming without account bookkeeping");
  const account = session?.account ?? null;
  const setCookie = session?.setCookie ?? null;
  const plan = planById(account?.plan ?? "FREE");
  const limitKey = account ? `account:${account.accountId}` : `anon:${ip}`;
  if (!rateLimit(limitKey, plan.rateLimit).ok) return json({ error: { code: "rate_limited", message: `Your plan allows ${plan.rateLimit} requests per minute.` } }, 429);

  const raw = await body<Record<string, unknown>>(req, 128 * 1024);
  const chat = validateChat({ ...raw, stream: true });
  const requestedMode = normalizeMode(String(raw.mode ?? "auto"));
  if (!plan.modes.includes(requestedMode)) return json({ error: { code: "mode_not_in_plan", message: `${requestedMode} routing is not included in the ${plan.name} plan.` } }, 403);
  // A node model (the Community GPU option) runs only on community Brain Nodes, whose operators can
  // read the prompt. Choosing it is choosing PUBLIC; the UI says so before the request is sent.
  const nodeModel = isAllowedModel(chat.model);
  const privacyRaw = String(raw.privacy ?? (nodeModel ? "public" : "standard")).toUpperCase() as PrivacyRequirement;
  const privacy = PRIVACY.has(privacyRaw) ? privacyRaw : "STANDARD";
  if (nodeModel && privacy !== "PUBLIC") return json({ error: { code: "privacy_conflict", message: `${chat.model} runs on community GPUs whose operators can read prompts; it needs PUBLIC privacy.` } }, 400);
  if (privacy === "PRIVATE" && !plan.privateRouting) return json({ error: { code: "privacy_not_in_plan", message: `PRIVATE routing is not included in the ${plan.name} plan.` } }, 403);
  // A PUBLIC request on a plan that runs on the community first goes to a GPU node when one can take
  // it (COMMUNITY mode); the AUTO ranking is the fallback. The receipt and the decision record the
  // mode that was actually used.
  const mode = requestedMode === "AUTO" && privacy === "PUBLIC" && !nodeModel && communityFirstFor(plan.id) ? "COMMUNITY" : requestedMode;

  if (account) {
    const bal = await withTimeout(
      ensureMonthlyGrant(account)
        .then(() => balance(account.accountId))
        .catch(() => null),
      remaining(),
      null,
    );
    if (bal && !mayConsume(bal)) return json({ error: { code: "out_of_credits", message: "You have used this month's included credits." }, balance: bal.balance }, 402);
  }

  const t0 = Date.now();
  const chatId = `chatcmpl-${randomBytes(10).toString("hex")}`;
  const messages = chat.messages[0]?.role === "system" ? chat.messages : [{ role: "system" as const, content: CHAT_SYSTEM_PROMPT }, ...chat.messages];
  // Community GPUs decode at consumer-card speed; a 4096-token budget would be a four-minute answer.
  const request = { kind: "chat" as const, model: chat.model, messages, maxTokens: nodeModel ? Math.min(chat.max_tokens ?? 512, 768) : chat.max_tokens, temperature: chat.temperature, privacy };
  const customerId = account ? `acct:${account.accountId}` : `anon:${ip}`;

  if (mode === "BROWSER_ONLY") {
    // The answer is produced by contributor nodes running a Qwen3 model's layers. No upstream provider, no
    // charge (research-grade; there is no measured price for it), its own small system prompt.
    const turns = [{ role: "system" as const, content: NETWORK_SYSTEM_PROMPT }, ...chat.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role as "user" | "assistant", content: typeof m.content === "string" ? m.content : String(m.content) }))];
    const stream = networkChatStream({
      messages: turns,
      maxTokens: Math.min(chat.max_tokens ?? 256, 512),
      temperature: chat.temperature ?? 0.6,
      chatId,
      model: "brain/network",
      t0,
      privacy,
      onComplete: async (brain) => {
        await recordRequest({
          customerId,
          at: t0,
          model: brain.model ?? "brain/network",
          endpoint: "chat.completions",
          route: { target: "BROWSER_NETWORK", providerId: "brain-network" },
          nodesUsed: brain.network?.stages.flatMap((s) => s.nodes.filter((n) => n.hops > 0).map((n) => n.id)) ?? [],
          inputUnits: brain.usage?.inputUnits ?? 0,
          outputUnits: brain.usage?.outputUnits ?? 0,
          cost: null,
          latencyMs: Date.now() - t0,
          receiptId: null,
          ok: brain.status === "COMPLETED",
          source: "REAL",
        });
      },
    });
    const headers: Record<string, string> = { ...sseHeaders };
    if (setCookie) headers["set-cookie"] = setCookie;
    return new Response(stream, { headers });
  }

  const stream = await chatEventStream({
    input: { request, mode, privacy },
    customerId,
    chatId,
    t0,
    mode,
    privacy,
    onComplete: async (order, s) => {
      if (account && s.receipt) await consumeForReceipt(account, s.receipt, { orderId: order.orderId, inputUnits: s.brain.usage?.inputUnits, outputUnits: s.brain.usage?.outputUnits });
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
