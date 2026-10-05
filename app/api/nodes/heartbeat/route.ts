import { nodeRoute } from "@/api/http";
import { authNode, heartbeat } from "@/services/nodes";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  return json({ node: await heartbeat(node) });
});
