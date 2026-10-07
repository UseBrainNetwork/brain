import type { FailedBody } from "@/node/protocol";
import { pathParam, signedNodeRoute } from "@/services/coordinator/http";
import { reportFailed } from "@/services/coordinator/jobs";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const POST = signedNodeRoute(async (node, body, req) => {
  const j = await reportFailed(node.nodeId, pathParam(req, 2), body as unknown as FailedBody);
  return json({ state: j.state });
});
