import { body, nodeRoute } from "@/api/http";
import { issueChallenge } from "@/services/nodes";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const POST = nodeRoute(async (req, { ip }) => {
  const b = await body<{ probeRoundsPerSec?: number }>(req);
  return json(await issueChallenge(ip, Number(b.probeRoundsPerSec)));
}, 20);
