import { nodeRoute } from "@/api/http";
import { getDecision, getOrder } from "@/engine/orders";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const GET = nodeRoute(async (req) => {
  const id = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "");
  const order = await getOrder(id);
  if (!order) return json({ error: "not_found" }, 404);
  const decision = order.decisionId ? await getDecision(order.decisionId) : null;
  return json({ order, decision });
});
