import { nodeRoute } from "@/api/http";
import { getEpochV2, verifyEpochHash } from "@/services/epochs";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const GET = nodeRoute(async (req) => {
  const id = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "");
  const epoch = await getEpochV2(id);
  if (!epoch) return json({ error: "not_found" }, 404);
  return json({ epoch, hashValid: verifyEpochHash(epoch) });
});
