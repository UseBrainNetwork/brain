import { nodeRoute } from "@/api/http";
import { networkConfig } from "@/lib/config";
import { concentrationOf } from "@/services/concentration";
import { lastKnownGood } from "@/services/failsoft";
import { sharedJson } from "@/services/security";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

/**
 * Public: how concentrated the live fleet is, as aggregates only (nodes per client address, nodes
 * per linked wallet, share of the largest groups). No address hash, wallet or node id is returned.
 */
async function build() {
  const t = Date.now();
  const nodes = (await getStore().listLiveNodes()).filter((n) => (n.status === "idle" || n.status === "computing") && t - n.lastHeartbeatAt <= networkConfig.nodes.offlineAfterMs);
  return concentrationOf(nodes);
}

export const GET = nodeRoute(async () => {
  const s = await lastKnownGood("network.concentration", 60_000, build);
  return sharedJson({ ...s.body, asOf: s.asOf, stale: s.stale }, 60);
}, 30);
