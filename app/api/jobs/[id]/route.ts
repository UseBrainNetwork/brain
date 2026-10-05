import { publicDistributedJob, publicJob } from "@/services/nodes";
import { json } from "@/services/security";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = getStore();
  const job = await store.getJob(id);
  if (job) return json({ job: publicJob(job) });
  const parent = await store.getDistributedJob(id);
  return parent ? json({ job: publicDistributedJob(parent), receiptId: `r-${parent.id}` }) : json({ error: "not_found" }, 404);
}
