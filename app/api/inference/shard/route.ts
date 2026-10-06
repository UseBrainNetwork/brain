import { after } from "next/server";
import { body, nodeRoute } from "@/api/http";
import { gatewayWeights, reportShard, type ShardRecord } from "@/services/inference";
import { authNode } from "@/services/nodes";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

const STATES = new Set<ShardRecord["state"]>(["loading", "ready", "failed"]);

/** Node reports shard load progress. "ready" makes it eligible for hops. */
export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  const b = await body<{ state?: string; progress?: number; error?: string }>(req, 4 * 1024);
  const state = STATES.has(b.state as ShardRecord["state"]) ? (b.state as ShardRecord["state"]) : null;
  if (!state) return json({ error: "invalid_state" }, 400);
  const record = await reportShard(node, { state, progress: Number(b.progress), error: b.error });
  // A stage coming online means a chat may follow: warm this instance's gateway weights now.
  if (state === "ready") after(() => gatewayWeights().catch(() => {}));
  return json({ shard: { stage: record.stage, state: record.state, progress: record.progress } });
});
