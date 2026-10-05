import { body, nodeRoute } from "@/api/http";
import type { ExecutionRequest, LegacyRoutingMode, PrivacyRequirement, Priority } from "@/domain/economy";
import { normalizeMode } from "@/domain/economy";
import { listOrders, placeOrder, publicOrder } from "@/engine/orders";
import { NodeError } from "@/services/nodes";
import { json, rateLimit } from "@/services/security";
import { ensureAccount } from "@/services/accounts";
import { balance, consumeForReceipt, ensureMonthlyGrant, mayConsume } from "@/services/credits";
import { planById } from "@/lib/plans";
import { getReceipt } from "@/services/receipts";

export const dynamic = "force-dynamic";

export const GET = nodeRoute(async (req) => {
  const limit = Math.min(50, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 20));
  return json({ orders: (await listOrders(limit)).map(publicOrder) });
});

const PRIO = new Set<Priority>(["CHEAP", "FAST", "BALANCED", "QUALITY"]);
const PRIVACY = new Set<PrivacyRequirement>(["PUBLIC", "STANDARD", "PRIVATE"]);

/**
 * Place a compute order from the console (/auto). Set BRAIN_DEMO_TOKEN to restrict.
 * Body: { request: ExecutionRequest, mode?: AUTO|CHEAP|FAST|QUALITY|BROWSER_ONLY, privacy?: PUBLIC|STANDARD|PRIVATE, maxCost?, maxLatency? }
 */
export const POST = nodeRoute(async (req) => {
  const token = process.env.BRAIN_DEMO_TOKEN;
  if (token && req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
  const b = await body<{ request?: ExecutionRequest; priority?: Priority; mode?: LegacyRoutingMode; privacy?: PrivacyRequirement; maxCost?: number | null; maxLatency?: number | null }>(req, 64 * 1024);
  const r = b.request;
  if (!r || (r.kind !== "compute" && r.kind !== "chat")) throw new NodeError("invalid_request", 400);
  if (r.kind === "compute" && (r.workload !== "matmul_u32" || !["small", "medium", "large"].includes(r.size))) throw new NodeError("invalid_request", 400);
  if (r.kind === "chat" && (!Array.isArray(r.messages) || r.messages.length === 0 || r.messages.length > 20 || r.messages.some((m) => typeof m?.content !== "string" || m.content.length > 8000))) throw new NodeError("invalid_request", 400);

  // Chat orders can reach a paid upstream model, so they are bound to the caller's account, plan and
  // credit ledger exactly like /chat. Compute orders run on browser nodes and cost nothing external.
  let acct: Awaited<ReturnType<typeof ensureAccount>> | null = null;
  if (r.kind === "chat") {
    acct = await ensureAccount(req);
    const plan = planById(acct.account.plan);
    if (!rateLimit(`account:${acct.account.accountId}`, plan.rateLimit).ok) return json({ error: { code: "rate_limited", message: `Your plan allows ${plan.rateLimit} requests per minute.` } }, 429);
    const mode = b.mode ? normalizeMode(b.mode) : "AUTO";
    if (!plan.modes.includes(mode)) return json({ error: { code: "mode_not_in_plan", message: `${mode} routing is not included in the ${plan.name} plan.` } }, 403);
    if (b.privacy === "PRIVATE" && !plan.privateRouting) return json({ error: { code: "privacy_not_in_plan", message: `PRIVATE routing is not included in the ${plan.name} plan.` } }, 403);
    await ensureMonthlyGrant(acct.account);
    if (!mayConsume(await balance(acct.account.accountId))) return json({ error: { code: "out_of_credits", message: "You have used this month's included credits." } }, 402);
  }
  const order = await placeOrder(
    {
      request:
        r.kind === "compute"
          ? { kind: "compute", workload: "matmul_u32", size: r.size, unitsPerNode: r.unitsPerNode, redundancy: r.redundancy === 2 ? 2 : 1 }
          : { kind: "chat", model: String(r.model || "brain/auto"), messages: r.messages.map((m) => ({ role: m.role, content: m.content })), maxTokens: r.maxTokens, temperature: r.temperature },
      priority: b.priority && PRIO.has(b.priority) ? b.priority : undefined,
      mode: b.mode ? normalizeMode(b.mode) : undefined,
      privacy: b.privacy && PRIVACY.has(b.privacy) ? b.privacy : undefined,
      maxCost: typeof b.maxCost === "number" ? b.maxCost : null,
      maxLatency: typeof b.maxLatency === "number" ? b.maxLatency : null,
    },
    acct ? `acct:${acct.account.accountId}` : "console",
  );
  if (acct && order.receiptId) {
    const receipt = await getReceipt(order.receiptId);
    if (receipt) await consumeForReceipt(acct.account, receipt, { orderId: order.orderId });
  }
  const res = json({ order }, 201);
  if (acct?.setCookie) res.headers.set("set-cookie", acct.setCookie);
  return res;
}, 30);
