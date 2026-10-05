import type { ComputeOrder } from "@/domain/economy";
import type { DistributedJob, WorkloadSize } from "@/domain/types";
import { createJob } from "./distributed";
import { NodeError } from "./nodes";

/**
 * Attached compute: every completed chat/inference request dispatches a real, verifiable workload to
 * the browser network, sized by the request. It is how customer traffic turns into node work today.
 *
 * Honest framing, enforced everywhere it is shown: the attached job did NOT produce the answer. The
 * answer came from the routed provider. The job is an integer matmul the server spot-checks; its
 * receipt is separate, labeled, priced at list price like any other distributed job, and its verified
 * units count toward the node's hourly reward share exactly like other verified work.
 */

export interface AttachedComputeSummary {
  jobId: string;
  size: WorkloadSize;
  workUnits: number;
  nodes: number;
  /** Why no job was dispatched, when it was not. */
  skipped?: "no_nodes" | "disabled" | "busy" | "error";
}

const enabled = () => process.env.BRAIN_ATTACHED_COMPUTE !== "off";

/** Tokens in → workload size. Larger requests fund larger units. */
export function sizeFor(units: number): WorkloadSize {
  if (units >= 4000) return "large";
  if (units >= 800) return "medium";
  return "small";
}

/** Nodes an attached job touches; attached work is spread thin so many nodes see customer traffic. */
export function nodesFor(units: number): number {
  return units >= 4000 ? 8 : units >= 800 ? 4 : 2;
}

export async function attachCompute(order: ComputeOrder, usage: { inputUnits: number; outputUnits: number } | undefined): Promise<AttachedComputeSummary | null> {
  if (!enabled()) return null;
  if (order.status !== "COMPLETED" || order.request.kind !== "chat") return null;
  const total = (usage?.inputUnits ?? 0) + (usage?.outputUnits ?? 0);
  const size = sizeFor(total);
  const maxNodes = nodesFor(total);
  try {
    const job: DistributedJob = await createJob({
      size,
      unitsPerNode: 1,
      maxNodes,
      redundancy: 1,
      attachedTo: { orderId: order.orderId, model: order.request.model, inputUnits: usage?.inputUnits ?? 0, outputUnits: usage?.outputUnits ?? 0 },
    });
    return { jobId: job.id, size, workUnits: job.totals.workUnits, nodes: job.nodeIds.length };
  } catch (e) {
    const code = e instanceof NodeError ? e.message : "error";
    return { jobId: "", size, workUnits: 0, nodes: 0, skipped: code === "no_real_nodes" ? "no_nodes" : code === "job_in_progress" ? "busy" : "error" };
  }
}
