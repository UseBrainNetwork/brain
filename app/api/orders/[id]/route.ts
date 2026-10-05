import { nodeRoute } from "@/api/http";
import { getDecision, getOrder, getPlan, publicOrder } from "@/engine/orders";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const GET = nodeRoute(async (req) => {
  const id = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "");
  const order = await getOrder(id);
  if (!order) return json({ error: "not_found" }, 404);
  const [decision, plan] = await Promise.all([order.decisionId ? getDecision(order.decisionId) : null, order.planId ? getPlan(order.planId) : null]);
  const publicPlan = plan ? { ...plan, steps: plan.steps.map(({ request: _r, result, ...st }) => ({ ...st, result: result ? { ...result, content: undefined } : undefined })) } : null;
  return json({ order: publicOrder(order), decision, plan: publicPlan });
});
