import { after } from "next/server";
import { body, nodeRoute } from "@/api/http";
import { authNode, jobPayload, nextJob, syntheticWaitMs } from "@/services/nodes";
import { ensureScheduledWork } from "@/services/scheduledWork";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  const b = await body<{ distributedOnly?: boolean }>(req);
  const job = await nextJob(node, { distributedOnly: b.distributedOnly === true });
  // Node polls are the network's clock: a poll that finds nothing lets the scheduler top the fleet
  // up with operator work, after this response is on the wire.
  if (!job) after(() => ensureScheduledWork().then((r) => r.job && console.log(`[scheduled-work] dispatched job #${r.job.id} ${r.job.size} ${r.job.totals.workUnits} units`)).catch(() => {}));
  // No job: tell the client how long until it is worth asking again, so idle nodes do not re-poll
  // the database every few seconds. Distributed work still wakes clients early via the event stream.
  const retryMs = job ? 0 : Math.max(3_500, syntheticWaitMs(node) + 250);
  return json({ job: job ? jobPayload(job) : null, retryMs });
});
