import "server-only";
import { nodeRoute } from "@/api/http";
import type { ImportedSpec } from "@/node/protocol";
import { listImportedModels, syncImportedModels, type ImportedModel } from "@/services/modelImports";
import { NodeError } from "@/services/nodes";
import { authenticateSigned, readSigned } from "./auth";
import { getNativeNode, type NativeNode } from "./registry";

/**
 * Route wrapper for signed node → coordinator calls: hashed-IP rate limit (nodeRoute), signature
 * envelope, node lookup, signature check against the node's bound key, replay guard.
 */
export function signedNodeRoute(handler: (node: NativeNode, body: Record<string, unknown>, req: Request) => Promise<Response>, limit?: number) {
  return nodeRoute(async (req) => {
    const path = new URL(req.url).pathname;
    try {
      const s = await readSigned(req);
      const node = await getNativeNode(s.nodeId);
      if (!node) throw new NodeError("unknown_node", 404);
      if (node.banReason) throw new NodeError("banned", 403);
      authenticateSigned(s, node.publicKey);
      // Imported models must be visible to every model-id check on this path (capabilities, jobs, settlement).
      await syncImportedModels();
      return await handler(node, s.body, req);
    } catch (e) {
      // A refused node call is an operational signal (a node aborts its job when a progress frame is
      // refused), so it is logged: code and path only, never the body or signature.
      if (e instanceof NodeError) console.warn(`[coordinator] refused ${req.headers.get("x-brain-node") ?? "?"} ${path}: ${e.status} ${e.code}`);
      throw e;
    }
  }, limit);
}

/** The imported-model table in wire form, most recently requested first, capped so a heartbeat stays small. */
export const importedSpecOf = (m: ImportedModel): ImportedSpec => ({ id: m.id, repo: m.repo, file: m.file.file, quant: m.file.quant, sizeBytes: m.file.sizeBytes, params: m.params, context: m.context, minVramMb: m.minVramMb, license: m.license });
export async function importedSpecsForWire(limit = 60): Promise<ImportedSpec[]> {
  const all = await listImportedModels().catch(() => [] as ImportedModel[]);
  return [...all].sort((a, b) => b.lastRequestedAt - a.lastRequestedAt).slice(0, limit).map(importedSpecOf);
}

/** Last path segment, e.g. the job id in /api/coordinator/jobs/<id>/progress. */
export function pathParam(req: Request, fromEnd = 1): string {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.length - fromEnd] ?? "");
}
