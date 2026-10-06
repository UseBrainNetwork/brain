import { nodeRoute } from "@/api/http";
import { assignShard } from "@/services/inference";
import { authNode } from "@/services/nodes";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

/** Which pipeline stage this node should load. Idempotent: a node keeps its stage across calls. */
export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  const { model, span, record } = await assignShard(node);
  return json({
    model: { id: model.id, label: model.label, repo: model.repo, revision: model.revision, weightsFile: model.weightsFile, license: model.license, config: model.config, stages: model.stages, maxContext: model.maxContext },
    span,
    state: record.state,
  });
});
