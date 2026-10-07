import { nodeRoute } from "@/api/http";
import { publicNativeNode, sweepNativeNodes } from "@/services/coordinator/registry";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

/** GET /api/coordinator/nodes — every native Brain Node the coordinator knows, public view (no keys, no IPs). */
export const GET = nodeRoute(async () => {
  const now = Date.now();
  const nodes = (await sweepNativeNodes(now)).map((n) => publicNativeNode(n, now));
  return json({ nodes, counts: { total: nodes.length, online: nodes.filter((n) => n.state === "ONLINE" || n.state === "BUSY").length, mock: nodes.filter((n) => n.gpu?.mock).length } });
});
