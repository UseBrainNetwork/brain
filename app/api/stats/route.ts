import { nodeRoute } from "@/api/http";
import { realSummary } from "@/services/distributed";
import { liveNodes } from "@/services/nodes";
import { json } from "@/services/security";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

/**
 * Tiny public stats document for badges and embeds (README shields, status pages).
 * REAL values only, measured by this server. Nothing simulated is ever reported here.
 */
export const GET = nodeRoute(async () => {
  const store = getStore() as ReturnType<typeof getStore> & { kind?: () => string };
  const [nodes, summary, nodesJoined] = await Promise.all([liveNodes(), realSummary(), store.countNodesJoined().catch(() => null)]);
  const backend = typeof store.kind === "function" ? store.kind() : "memory";
  return json(
    {
      source: "REAL",
      nodesOnline: nodes.length,
      /** Distinct GPUs that have registered since launch. null if the store cannot count. */
      nodesJoined,
      jobsCompleted: summary.jobsCompleted,
      workUnitsVerified: summary.workUnitsVerified,
      verifiedComputeUnits: summary.verifiedComputeUnits,
      successRate: summary.successRate,
      backend,
      at: Date.now(),
    },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=60", "Access-Control-Allow-Origin": "*" } },
  );
});
