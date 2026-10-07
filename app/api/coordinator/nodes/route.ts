import { nodeRoute } from "@/api/http";
import { publicNativeNode, sweepNativeNodes } from "@/services/coordinator/registry";
import { lastKnownGood } from "@/services/failsoft";
import { sharedJson } from "@/services/security";

export const dynamic = "force-dynamic";

/** GET /api/coordinator/nodes — every native Brain Node the coordinator knows, public view (no keys, no IPs). */
const TTL_MS = 3_000;

async function build() {
  const now = Date.now();
  // Nodes silent for a week drop off the public list (their records stay for when they return).
  const nodes = (await sweepNativeNodes(now)).filter((n) => n.state !== "OFFLINE" || now - n.lastHeartbeatAt < 7 * 86_400_000).map((n) => publicNativeNode(n, now));
  return { nodes, counts: { total: nodes.length, online: nodes.filter((n) => n.state === "ONLINE" || n.state === "BUSY").length, mock: nodes.filter((n) => n.gpu?.mock).length } };
}

/** Shared across viewers for a few seconds: every /network, /models and /provider tab polls this. */
export const GET = nodeRoute(async () => {
  const s = await lastKnownGood("coordinator.nodes", TTL_MS, build);
  return sharedJson({ ...s.body, asOf: s.asOf, stale: s.stale }, 3);
});
