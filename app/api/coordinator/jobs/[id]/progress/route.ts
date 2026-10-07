import type { ProgressBody } from "@/node/protocol";
import { pathParam, signedNodeRoute } from "@/services/coordinator/http";
import { reportProgress } from "@/services/coordinator/jobs";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const POST = signedNodeRoute(async (node, body, req) => {
  const j = await reportProgress(node.nodeId, pathParam(req, 2), body as unknown as ProgressBody);
  return json({ state: j.state, seq: j.seq });
}, 6000);
