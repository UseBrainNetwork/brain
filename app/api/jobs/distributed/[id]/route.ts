import { nodeRoute } from "@/api/http";
import { getJob } from "@/services/distributed";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const GET = nodeRoute(async (req) => {
  const id = new URL(req.url).pathname.split("/").pop() ?? "";
  const job = await getJob(id);
  return job ? json({ job }) : json({ error: "not_found" }, 404);
});
