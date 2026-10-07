import type { CompletedBody } from "@/node/protocol";
import { pathParam, signedNodeRoute } from "@/services/coordinator/http";
import { reportCompleted } from "@/services/coordinator/jobs";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const POST = signedNodeRoute(async (node, body, req) => {
  const j = await reportCompleted(node.nodeId, pathParam(req, 2), body as unknown as CompletedBody);
  return json({ state: j.state, receiptId: j.receiptId, failureReason: j.failureReason });
});
