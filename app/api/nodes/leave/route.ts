import { nodeRoute } from "@/api/http";
import { authNode, leave } from "@/services/nodes";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  await leave(node);
  return json({ ok: true });
});
