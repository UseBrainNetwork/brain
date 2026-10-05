import { body, nodeRoute } from "@/api/http";
import type { WorkloadSize } from "@/domain/types";
import { createJob, listJobs } from "@/services/distributed";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

/** Recent distributed jobs (real, this server). */
export const GET = nodeRoute(async (req) => {
  const limit = Math.min(50, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 10));
  return json({ jobs: await listJobs(limit) });
});

/**
 * Submit a distributed job. One in flight per server; requires ≥1 real node.
 * Rate limited per IP like every node route. Set BRAIN_DEMO_TOKEN to restrict.
 */
export const POST = nodeRoute(async (req) => {
  const token = process.env.BRAIN_DEMO_TOKEN;
  if (token && req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
  const b = await body<{ size?: WorkloadSize; unitsPerNode?: number; redundancy?: 1 | 2 }>(req);
  const job = await createJob({ size: b.size, unitsPerNode: b.unitsPerNode, redundancy: b.redundancy });
  return json({ job }, 201);
}, 30);
