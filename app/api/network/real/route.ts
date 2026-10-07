import { nodeRoute } from "@/api/http";
import { realSummary } from "@/services/distributed";
import { lastKnownGood } from "@/services/failsoft";
import { liveNodes } from "@/services/nodes";
import { sharedJson } from "@/services/security";

export const dynamic = "force-dynamic";

/** Polled every 4 s by every viewer; one snapshot per instance per 3 s serves them all. */
const TTL_MS = 3_000;

async function build() {
  const [nodes, summary] = await Promise.all([liveNodes(), realSummary()]);
  return { nodes, summary };
}

/**
 * REAL MODE snapshot: only devices connected to this server and work it verified.
 * When the database is unreachable the previous snapshot is returned with `stale: true` and `asOf`
 * so the UI can say "live data delayed" instead of showing an empty network.
 */
export const GET = nodeRoute(async () => {
  const s = await lastKnownGood("network.real", TTL_MS, build);
  return sharedJson({ ...s.body, asOf: s.asOf, stale: s.stale }, 3);
});
