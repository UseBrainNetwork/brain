import { nodeRoute } from "@/api/http";
import { nodeEconomics, nodeProfile } from "@/services/nodeProfile";
import { publicJob } from "@/services/nodes";
import { json } from "@/services/security";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

/** Public reputation profile + recent (secret-free) job records for one anonymous node. */
export const GET = nodeRoute(async (req) => {
  const id = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "").toUpperCase();
  const profile = await nodeProfile(id);
  if (!profile) return json({ error: "not_found" }, 404);
  const [jobs, economics] = await Promise.all([getStore().listJobsForNode(id, 25).then((js) => js.map(publicJob)), nodeEconomics(id)]);
  return json({ profile, jobs, economics });
});
