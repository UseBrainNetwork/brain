import { nodeRoute } from "@/api/http";
import { listInferenceJobs, publicInferenceJob, sweepInferenceJobs } from "@/services/coordinator/jobs";
import { lastKnownGood } from "@/services/failsoft";
import { sharedJson } from "@/services/security";

export const dynamic = "force-dynamic";

/** GET /api/coordinator/jobs?limit=20 — recent native-node inference jobs, public view. */
const TTL_MS = 3_000;

export const GET = nodeRoute(async (req) => {
  const limit = Math.min(100, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 20));
  const s = await lastKnownGood(`coordinator.jobs.${limit}`, TTL_MS, async () => {
    await sweepInferenceJobs();
    return { jobs: (await listInferenceJobs(limit)).map(publicInferenceJob) };
  });
  return sharedJson({ ...s.body, asOf: s.asOf, stale: s.stale }, 3);
});
