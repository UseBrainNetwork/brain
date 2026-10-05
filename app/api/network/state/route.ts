import { liveNodes, publicJob } from "@/services/nodes";
import { sharedJson } from "@/services/security";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

/** Real server-side state only. Simulated network data is never served from here. */
export async function GET() {
  const [nodes, jobs] = await Promise.all([liveNodes(), getStore().listRecentJobs(50)]);
  return sharedJson({ provenance: "live", nodes, jobs: jobs.map(publicJob) }, 3);
}
