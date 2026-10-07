import { nodeRoute } from "@/api/http";
import { pathParam } from "@/services/coordinator/http";
import { getInferenceJobPublic, sweepInferenceJobs } from "@/services/coordinator/jobs";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

/** GET /api/coordinator/jobs/<id> — public job record: state history, timing, routing reason. No prompt, no output. */
export const GET = nodeRoute(async (req) => {
  await sweepInferenceJobs();
  const j = await getInferenceJobPublic(pathParam(req, 1));
  return j ? json(j) : json({ error: "not_found" }, 404);
});
