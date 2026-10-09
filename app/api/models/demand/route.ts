import { nodeRoute } from "@/api/http";
import { lastKnownGood } from "@/services/failsoft";
import { modelDemand } from "@/services/modelDemand";
import { sharedJson } from "@/services/security";

export const dynamic = "force-dynamic";

/**
 * GET /api/models/demand — per allowlisted model, orders asked / served / unserved over the last
 * 24 h, from the order log. The signal an operator reads before pinning a model.
 */
const TTL_MS = 60_000;

export const GET = nodeRoute(async () => {
  const s = await lastKnownGood("models.demand", TTL_MS, () => modelDemand());
  return sharedJson({ ...s.body, asOf: s.asOf, stale: s.stale }, 60);
});
