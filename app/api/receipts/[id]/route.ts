import { nodeRoute } from "@/api/http";
import { getDecision } from "@/engine/orders";
import { getJob } from "@/services/distributed";
import { getReceipt } from "@/services/receipts";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const GET = nodeRoute(async (req) => {
  const id = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "");
  const receipt = await getReceipt(id);
  if (!receipt) return json({ error: "not_found" }, 404);
  const [job, decision] = await Promise.all([receipt.workloadType === "matmul_u32" ? getJob(receipt.jobId) : null, receipt.route?.decisionId ? getDecision(receipt.route.decisionId) : null]);
  return json({ receipt, job, decision });
});
