import { modelSpec } from "@/node/models";
import { getStore, type WorkRecord } from "@/services/store";
import { probeKind } from "./probes";

/**
 * Settlement feed for native GPU nodes.
 *
 * A customer inference job the coordinator saw through to COMPLETED becomes one work record in the
 * same aggregate the browser kernels settle from, so the hourly epoch has one population. Benchmarks
 * and canaries never enter it: they are the coordinator's own prompts and paying for them would pay
 * nodes for answering four fixed questions. A shadow re-run does enter it, but only when it agreed
 * with the customer job it re-ran: that is a real prompt on a real model, chosen by the coordinator
 * and checked against a second machine (`recordShadowWork`).
 *
 * Compute units use the unit the network already defines for LLM work (network/workloads.ts,
 * `llm_stage`): one unit = 2^20 multiply-accumulates, and a transformer spends ≈ one MAC per
 * parameter per token. So units = params × tokens / 2^20. A 1.5B model producing 128 tokens from a
 * 50-token prompt is ≈ 255k units. It is the same yardstick the browser kernels are measured with,
 * not a price and not a conversion rate chosen for either side.
 *
 * What "verified" means here is what the coordinator actually established: it streamed the tokens
 * itself and timed them, the final text matched the stream and its hash, token counts were bounded
 * by the text, and the node had passed benchmark and canaries to be routed at all. When a shadow
 * replica later disagrees, the record is disputed: unpaid, and a lost unit rather than a failed
 * check, because the coordinator cannot tell which of the two nodes was wrong. Re-execution of the
 * model is not part of this; docs/architecture.md says so.
 */

interface SettleableJob {
  jobId: string;
  requesterId: string;
  model: string;
  assignedNode: string | null;
  createdAt: number;
  tokenUsage: { prompt: number; completion: number } | null;
  request: { messages: { content: string }[] };
  output: string;
}

/** "1.5B" → 1.5e9, "7B" → 7e9, "0" → 0. */
export function paramCount(params: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([KMBT]?)$/i.exec(params.trim());
  if (!m) return 0;
  const scale: Record<string, number> = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return Number(m[1]) * scale[m[2].toUpperCase()];
}

/** Units for a completed job; 0 for mock models or anything without a parameter count. */
export function nativeComputeUnits(j: SettleableJob): number {
  const spec = modelSpec(j.model);
  if (!spec || spec.mock) return 0;
  const params = paramCount(spec.params);
  if (!(params > 0) || !j.tokenUsage) return 0;
  // Token counts are node-reported; the coordinator bounds them by text it saw itself.
  const promptChars = j.request.messages.reduce((s, m) => s + m.content.length, 0);
  const prompt = Math.min(Math.max(0, j.tokenUsage.prompt), promptChars + 16);
  const completion = Math.min(Math.max(0, j.tokenUsage.completion), j.output.length + 16);
  return Math.round((params * (prompt + completion)) / 1_048_576);
}

export const isSettleable = (j: { requesterId: string; assignedNode: string | null }) => probeKind(j) === "inference" && Boolean(j.assignedNode);

/** Records a completed customer job as verified work. No-op for probes, mock models and unassigned jobs. */
export async function recordNativeWork(j: SettleableJob): Promise<WorkRecord | null> {
  if (!isSettleable(j)) return null;
  return recordVerifiedUnits(j, "native-inference");
}

/**
 * Records a shadow re-run that agreed with the customer job it checked. The shadow node ran the
 * same real prompt on the same model and its answer matched; that is verified compute by a stricter
 * test than the primary's, chosen by the coordinator, so it settles like the primary's. Only
 * `recordShadowResult` calls this, and only on a match: a shadow that failed, timed out or
 * disagreed is not paid.
 */
export async function recordShadowWork(j: SettleableJob): Promise<WorkRecord | null> {
  if (probeKind(j) !== "verify" || !j.assignedNode) return null;
  return recordVerifiedUnits(j, "native-verify");
}

async function recordVerifiedUnits(j: SettleableJob, source: WorkRecord["source"]): Promise<WorkRecord | null> {
  const computeUnits = nativeComputeUnits(j);
  if (computeUnits <= 0) return null;
  const w: WorkRecord = {
    id: j.jobId,
    source,
    assignedTo: j.assignedNode!,
    status: "completed",
    submittedAt: j.createdAt,
    verified: true,
    computeUnits,
    model: j.model,
    tokens: { prompt: j.tokenUsage?.prompt ?? 0, completion: j.tokenUsage?.completion ?? 0 },
  };
  await getStore().recordWork(w);
  return w;
}

/**
 * Records a failed customer job. Failures the node is not shown to be responsible for map onto the
 * settlement's "lost unit" reasons (they lower completion rate, never the pass rate); a
 * verification failure is the node's own.
 */
export async function recordNativeFailure(j: SettleableJob & { failureReason: string | null }, timedOut: boolean): Promise<WorkRecord | null> {
  if (!isSettleable(j)) return null;
  const spec = modelSpec(j.model);
  if (!spec || spec.mock) return null;
  const reason = j.failureReason ?? "failed";
  const failReason = timedOut || reason === "timeout" ? "deadline" : reason === "node_offline" || reason === "node lost" ? "node lost" : reason;
  const w: WorkRecord = {
    id: j.jobId,
    source: "native-inference",
    assignedTo: j.assignedNode!,
    status: "failed",
    submittedAt: j.createdAt,
    verified: false,
    failReason,
    computeUnits: 0,
    model: j.model,
    tokens: { prompt: 0, completion: 0 },
  };
  await getStore().recordWork(w);
  return w;
}

/** A shadow replica disagreed: the work is unpaid and the unit is lost rather than failed. */
export async function disputeNativeWork(jobId: string): Promise<void> {
  const store = getStore();
  const w = await store.getWork(jobId);
  if (!w || !w.verified) return;
  await store.recordWork({ ...w, status: "failed", verified: false, failReason: "replica-dispute", computeUnits: 0 });
}
