import { body, nodeRoute } from "@/api/http";
import { nextHop } from "@/services/inference";
import { authNode } from "@/services/nodes";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** Long-poll for the next hop assigned to this node. Returns immediately when the network is idle. */
export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  const b = await body<{ waitMs?: number }>(req, 1024);
  const r = await nextHop(node, Math.max(0, Math.min(8_000, Number(b.waitMs) || 0)));
  return json(r);
}, 2_000);
