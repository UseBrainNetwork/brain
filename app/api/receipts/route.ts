import { nodeRoute } from "@/api/http";
import { listReceipts } from "@/services/receipts";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const GET = nodeRoute(async (req) => {
  const limit = Math.min(100, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 20));
  return json({ receipts: await listReceipts(limit) });
});
