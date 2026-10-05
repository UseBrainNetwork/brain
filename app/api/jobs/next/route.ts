import { body, nodeRoute } from "@/api/http";
import { authNode, jobPayload, nextJob } from "@/services/nodes";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  const b = await body<{ distributedOnly?: boolean }>(req);
  const job = await nextJob(node, { distributedOnly: b.distributedOnly === true });
  return json({ job: job ? jobPayload(job) : null });
});
