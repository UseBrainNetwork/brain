import { nodeRoute } from "@/api/http";
import { listInferenceJobs, publicInferenceJob, sweepInferenceJobs } from "@/services/coordinator/jobs";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

/** GET /api/coordinator/jobs?limit=20 — recent native-node inference jobs, public view. */
export const GET = nodeRoute(async (req) => {
  await sweepInferenceJobs();
  const limit = Math.min(100, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 20));
  return json({ jobs: (await listInferenceJobs(limit)).map(publicInferenceJob) });
});
