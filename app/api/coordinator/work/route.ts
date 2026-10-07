import { DEFAULTS } from "@/node/protocol";
import { signedNodeRoute } from "@/services/coordinator/http";
import { nextWorkFor, sweepInferenceJobs } from "@/services/coordinator/jobs";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/coordinator/work — long poll. Answers as soon as a job is assigned to this node, or
 * with `job: null` after `waitMs` (≤ 20 s). Nodes connect outbound only; nothing dials them.
 */
export const POST = signedNodeRoute(async (node, body) => {
  if (node.state === "OFFLINE") return json({ job: null, serverTime: Date.now(), instruction: "heartbeat" });
  await sweepInferenceJobs();
  const waitMs = Math.min(DEFAULTS.workPollMs, Math.max(0, Number(body.waitMs) || DEFAULTS.workPollMs));
  const job = await nextWorkFor(node.nodeId, waitMs);
  return json({ job, serverTime: Date.now() });
}, 1200);
