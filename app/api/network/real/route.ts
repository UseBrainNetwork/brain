import { nodeRoute } from "@/api/http";
import { realSummary } from "@/services/distributed";
import { liveNodes } from "@/services/nodes";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

/** REAL MODE snapshot: only devices connected to this server and work it verified. */
export const GET = nodeRoute(async () => {
  const [nodes, summary] = await Promise.all([liveNodes(), realSummary()]);
  return json({ nodes, summary });
});
