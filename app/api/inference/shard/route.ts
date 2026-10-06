import { body, nodeRoute } from "@/api/http";
import { reportShard, type ShardRecord } from "@/services/inference";
import { authNode } from "@/services/nodes";
import { nodeRelayTicket } from "@/services/relay";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

const STATES = new Set<ShardRecord["state"]>(["loading", "ready", "failed"]);

/**
 * Node reports shard load progress. On "ready" the response includes a relay ticket: the node
 * connects its stage to the relay with it and serves hops from there.
 */
export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  const b = await body<{ state?: string; progress?: number; error?: string }>(req, 4 * 1024);
  const state = STATES.has(b.state as ShardRecord["state"]) ? (b.state as ShardRecord["state"]) : null;
  if (!state) return json({ error: "invalid_state" }, 400);
  const record = await reportShard(node, { state, progress: Number(b.progress), error: b.error });
  const relay = state === "ready" ? await nodeRelayTicket(node.id, record.model, record.stage) : null;
  return json({ shard: { model: record.model, stage: record.stage, state: record.state, progress: record.progress }, relay });
});
