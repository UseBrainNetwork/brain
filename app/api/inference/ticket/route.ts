import { nodeRoute } from "@/api/http";
import { shardOf } from "@/services/inference";
import { authNode } from "@/services/nodes";
import { nodeRelayTicket, relayConfigured } from "@/services/relay";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

/** A fresh relay ticket for this node's ready stage (reconnects, ticket expiry). */
export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  if (!relayConfigured()) return json({ error: "relay_unconfigured" }, 503);
  const shard = await shardOf(node);
  if (!shard || shard.state !== "ready") return json({ error: "not_ready" }, 409);
  const relay = await nodeRelayTicket(node.id, shard.model, shard.stage);
  return json({ relay });
});
