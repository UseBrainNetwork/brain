import { body, nodeRoute } from "@/api/http";
import { NETWORK_MODELS } from "@/inference/config";
import { assignShard } from "@/services/inference";
import { authNode } from "@/services/nodes";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

/** Which model and pipeline stage this node should load. Idempotent: a node keeps its stage across calls. */
export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  const b = await body<{ model?: string }>(req, 1024);
  const requested = typeof b.model === "string" ? NETWORK_MODELS[b.model] : undefined;
  const { model, span, record } = await assignShard(node, requested);
  return json({
    model: {
      id: model.id,
      label: model.label,
      params: model.params,
      repo: model.repo,
      revision: model.revision,
      weightsFile: model.weightsFile,
      license: model.license,
      quant: model.quant,
      config: model.config,
      stageLayers: model.stageLayers,
      maxContext: model.maxContext,
    },
    span,
    state: record.state,
  });
});
