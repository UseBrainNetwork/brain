import { nodeRoute } from "@/api/http";
import { listInferenceJobs, publicInferenceJob, sweepInferenceJobs } from "@/services/coordinator/jobs";
import { sharedJson } from "@/services/security";

export const dynamic = "force-dynamic";

/** GET /api/coordinator/jobs?limit=20 — recent native-node inference jobs, public view. */
const TTL_MS = 3_000;
const st = globalThis as typeof globalThis & { __brainNJobsView?: Map<number, { at: number; body: unknown }> };

export const GET = nodeRoute(async (req) => {
  await sweepInferenceJobs();
  const limit = Math.min(100, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 20));
  const m = (st.__brainNJobsView ??= new Map());
  const now = Date.now();
  const hit = m.get(limit);
  if (hit && now - hit.at < TTL_MS) return sharedJson(hit.body, 3);
  const body = { jobs: (await listInferenceJobs(limit)).map(publicInferenceJob), asOf: now };
  m.set(limit, { at: now, body });
  return sharedJson(body, 3);
});
