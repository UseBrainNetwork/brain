import { body, nodeRoute } from "@/api/http";
import { registerNode, type RegisterInput } from "@/services/nodes";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const POST = nodeRoute(async (req, { ip }) => {
  const b = await body<RegisterInput>(req);
  return json(await registerNode(ip, b));
}, 10);
