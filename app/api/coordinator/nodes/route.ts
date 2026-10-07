import { nodeRoute } from "@/api/http";
import { publicNativeNode, sweepNativeNodes } from "@/services/coordinator/registry";
import { sharedJson } from "@/services/security";

export const dynamic = "force-dynamic";

/** GET /api/coordinator/nodes — every native Brain Node the coordinator knows, public view (no keys, no IPs). */
const TTL_MS = 3_000;
const st = globalThis as typeof globalThis & { __brainNNodesView?: { at: number; body: unknown } };

/** Shared across viewers for a few seconds: every /network, /models and /provider tab polls this. */
export const GET = nodeRoute(async () => {
  const now = Date.now();
  if (st.__brainNNodesView && now - st.__brainNNodesView.at < TTL_MS) return sharedJson(st.__brainNNodesView.body, 3);
  // Nodes silent for a week drop off the public list (their records stay for when they return).
  const nodes = (await sweepNativeNodes(now)).filter((n) => n.state !== "OFFLINE" || now - n.lastHeartbeatAt < 7 * 86_400_000).map((n) => publicNativeNode(n, now));
  const body = { nodes, counts: { total: nodes.length, online: nodes.filter((n) => n.state === "ONLINE" || n.state === "BUSY").length, mock: nodes.filter((n) => n.gpu?.mock).length }, asOf: now };
  st.__brainNNodesView = { at: now, body };
  return sharedJson(body, 3);
});
