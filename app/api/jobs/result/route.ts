import { body, nodeRoute } from "@/api/http";
import type { WorkloadResult } from "@/network/workloads";
import { authNode, submitResult } from "@/services/nodes";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  const b = await body<{ jobId: string; result: WorkloadResult; clientGpuMs: number }>(req);
  return json(await submitResult(node, b.jobId, b.result, b.clientGpuMs));
});
