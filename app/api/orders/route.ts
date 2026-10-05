import { body, nodeRoute } from "@/api/http";
import type { ExecutionRequest, Priority, RoutingMode } from "@/domain/economy";
import { listOrders, placeOrder } from "@/engine/orders";
import { NodeError } from "@/services/nodes";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const GET = nodeRoute(async (req) => {
  const limit = Math.min(50, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 20));
  return json({ orders: await listOrders(limit) });
});

const PRIO = new Set<Priority>(["CHEAP", "FAST", "BALANCED"]);
const MODES = new Set<RoutingMode>(["AUTO", "CHEAPEST", "FASTEST", "BROWSER_ONLY"]);

/**
 * Place a compute order from the console (/auto). Set BRAIN_DEMO_TOKEN to restrict.
 * Body: { request: ExecutionRequest, priority?, mode?, maxCost?, maxLatency? }
 */
export const POST = nodeRoute(async (req) => {
  const token = process.env.BRAIN_DEMO_TOKEN;
  if (token && req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
  const b = await body<{ request?: ExecutionRequest; priority?: Priority; mode?: RoutingMode; maxCost?: number | null; maxLatency?: number | null }>(req, 64 * 1024);
  const r = b.request;
  if (!r || (r.kind !== "compute" && r.kind !== "chat")) throw new NodeError("invalid_request", 400);
  if (r.kind === "compute" && (r.workload !== "matmul_u32" || !["small", "medium", "large"].includes(r.size))) throw new NodeError("invalid_request", 400);
  if (r.kind === "chat" && (!Array.isArray(r.messages) || r.messages.length === 0 || r.messages.length > 20 || r.messages.some((m) => typeof m?.content !== "string" || m.content.length > 8000))) throw new NodeError("invalid_request", 400);
  const order = await placeOrder(
    {
      request:
        r.kind === "compute"
          ? { kind: "compute", workload: "matmul_u32", size: r.size, unitsPerNode: r.unitsPerNode, redundancy: r.redundancy === 2 ? 2 : 1 }
          : { kind: "chat", model: String(r.model || "brain/auto"), messages: r.messages.map((m) => ({ role: m.role, content: m.content })), maxTokens: r.maxTokens, temperature: r.temperature },
      priority: b.priority && PRIO.has(b.priority) ? b.priority : undefined,
      mode: b.mode && MODES.has(b.mode) ? b.mode : undefined,
      maxCost: typeof b.maxCost === "number" ? b.maxCost : null,
      maxLatency: typeof b.maxLatency === "number" ? b.maxLatency : null,
    },
    "console",
  );
  return json({ order }, 201);
}, 30);
