import { body, nodeRoute } from "@/api/http";
import { authNode, startWork } from "@/services/nodes";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

/** Node signals it began executing its assigned unit. Drives the live visualization only. */
export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  const b = await body<{ jobId: string }>(req);
  return json(await startWork(node, String(b.jobId ?? "")));
});
