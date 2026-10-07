import { nodeRoute } from "@/api/http";
import { realSummary } from "@/services/distributed";
import { lastKnownGood } from "@/services/failsoft";
import { liveNodes } from "@/services/nodes";
import { json } from "@/services/security";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

/**
 * Tiny public stats document for badges and embeds (README shields, status pages).
 * REAL values only, measured by this server. Nothing simulated is ever reported here.
 */
async function build() {
  const store = getStore() as ReturnType<typeof getStore> & { kind?: () => string };
  const [nodes, summary, nodesJoined] = await Promise.all([liveNodes(), realSummary(), store.countNodesJoined().catch(() => null)]);
  const backend = typeof store.kind === "function" ? store.kind() : "memory";
  return {
    source: "REAL" as const,
    nodesOnline: nodes.length,
    /** Distinct GPUs that have registered since launch. null if the store cannot count. */
    nodesJoined,
    jobsCompleted: summary.jobsCompleted,
    workUnitsVerified: summary.workUnitsVerified,
    verifiedComputeUnits: summary.verifiedComputeUnits,
    successRate: summary.successRate,
    backend,
  };
}

export const GET = nodeRoute(async () => {
  // If the database is unreachable, the last body this instance built is returned with `stale: true`
  // and the time it was measured. No previous body: 503, fast.
  const s = await lastKnownGood("stats", 30_000, build);
  return json(
    { ...s.body, at: s.asOf, stale: s.stale },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=60, stale-if-error=3600", "Access-Control-Allow-Origin": "*" } },
  );
});
