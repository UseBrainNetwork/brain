import "server-only";
import { nodeRoute } from "@/api/http";
import { NodeError } from "@/services/nodes";
import { authenticateSigned, readSigned } from "./auth";
import { getNativeNode, type NativeNode } from "./registry";

/**
 * Route wrapper for signed node → coordinator calls: hashed-IP rate limit (nodeRoute), signature
 * envelope, node lookup, signature check against the node's bound key, replay guard.
 */
export function signedNodeRoute(handler: (node: NativeNode, body: Record<string, unknown>, req: Request) => Promise<Response>, limit?: number) {
  return nodeRoute(async (req) => {
    const s = await readSigned(req);
    const node = await getNativeNode(s.nodeId);
    if (!node) throw new NodeError("unknown_node", 404);
    if (node.banReason) throw new NodeError("banned", 403);
    authenticateSigned(s, node.publicKey);
    return handler(node, s.body, req);
  }, limit);
}

/** Last path segment, e.g. the job id in /api/coordinator/jobs/<id>/progress. */
export function pathParam(req: Request, fromEnd = 1): string {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.length - fromEnd] ?? "");
}
