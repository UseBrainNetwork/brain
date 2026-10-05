import { body, nodeRoute } from "@/api/http";
import { authNode, jobPayload, nextJob, syntheticWaitMs } from "@/services/nodes";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  const b = await body<{ distributedOnly?: boolean }>(req);
  const job = await nextJob(node, { distributedOnly: b.distributedOnly === true });
  // No job: tell the client how long until it is worth asking again, so idle nodes do not re-poll
  // the database every few seconds. Distributed work still wakes clients early via the event stream.
  const retryMs = job ? 0 : Math.max(3_500, syntheticWaitMs(node) + 250);
  return json({ job: job ? jobPayload(job) : null, retryMs });
});
