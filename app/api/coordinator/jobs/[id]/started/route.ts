import type { StartedBody } from "@/node/protocol";
import { pathParam, signedNodeRoute } from "@/services/coordinator/http";
import { reportStarted } from "@/services/coordinator/jobs";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const POST = signedNodeRoute(async (node, body, req) => {
  const j = await reportStarted(node.nodeId, pathParam(req, 2), body as unknown as StartedBody);
  return json({ state: j.state });
});
