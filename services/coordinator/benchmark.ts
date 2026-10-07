import "server-only";
import type { ComputeClass } from "@/node/models";
import { createInferenceJob, getInferenceJob, matchJob, type InferenceJob } from "./jobs";
import { getNativeNode, updateNativeNode, type NativeNode } from "./registry";

/**
 * Benchmark on join. The coordinator sends a node a fixed inference job pinned to that node and
 * times it on its own clock. Decode speed (completion tokens ÷ coordinator-measured generation
 * time) and time-to-first-byte become the node's benchmark; the compute class follows from the
 * measured speed, never from the GPU name the node reported.
 *
 * Benchmark jobs are coordinator-initiated: they issue no receipt, bill nobody and earn nothing.
 * Mock nodes are timed too (so the pipeline is exercised) but are never given a compute class.
 */
export const BENCHMARK_REQUESTER = "coordinator:benchmark";
export const isBenchmarkJob = (j: Pick<InferenceJob, "requesterId">) => j.requesterId === BENCHMARK_REQUESTER;

const PROMPT = "Write a short, plain description of how a distributed compute network schedules work across machines. Use complete sentences.";
const MAX_TOKENS = 128;
/** Re-benchmark after this long so a node that changed hardware is re-classified. */
export const BENCHMARK_TTL_MS = 24 * 3_600_000;

/**
 * Single-stream decode speed thresholds, tokens per second as timed by the coordinator (includes
 * network overhead, which is intended: that is the speed a developer experiences). Policy, not
 * measurement; tune here only.
 */
export const CLASS_THRESHOLDS: { cls: ComputeClass; minTokPerSec: number }[] = [
  { cls: "DATACENTER", minTokPerSec: 90 },
  { cls: "PRO", minTokPerSec: 40 },
  { cls: "CONSUMER", minTokPerSec: 12 },
  { cls: "EDGE", minTokPerSec: 0 },
];

export function classify(tokPerSec: number, mock: boolean): ComputeClass | null {
  if (mock || !Number.isFinite(tokPerSec)) return null;
  return CLASS_THRESHOLDS.find((t) => tokPerSec >= t.minTokPerSec)?.cls ?? "EDGE";
}

const needsBenchmark = (n: NativeNode, now: number) => n.benchmark.basis === "unmeasured" || (n.benchmark.at != null && now - n.benchmark.at > BENCHMARK_TTL_MS);
const hasPendingBenchmark = (n: NativeNode) => n.activeJobIds.some((id) => id.startsWith("bj-"));

/**
 * Creates and dispatches a benchmark job for the node when one is due and the node can take it
 * (ONLINE with a free slot, at least one accepted model). Idempotent per node: one pending
 * benchmark at a time. Never throws into the request path.
 */
export async function scheduleBenchmark(nodeId: string, now = Date.now()): Promise<InferenceJob | null> {
  try {
    const n = await getNativeNode(nodeId);
    if (!n || n.state !== "ONLINE" || !needsBenchmark(n, now) || hasPendingBenchmark(n)) return null;
    const model = n.reported.capabilities.supportedModels[0];
    if (!model) return null;
    const job = await createInferenceJob(
      { requesterId: BENCHMARK_REQUESTER, model, messages: [{ role: "user", content: PROMPT }], maxTokens: MAX_TOKENS, temperature: 0, pinnedNode: nodeId, ttlMs: 90_000, idPrefix: "bj" },
      now,
    );
    return await matchJob(job.jobId, now);
  } catch (e) {
    console.error("[coordinator] benchmark scheduling failed", e);
    return null;
  }
}

/** Records a completed benchmark against its node. Called from the job state machine after the job lock is released. */
export async function recordBenchmark(jobId: string, tokPerSec: number, firstByteMs: number | null, now = Date.now()) {
  const j = await getInferenceJob(jobId);
  if (!j || !j.assignedNode || !isBenchmarkJob(j)) return;
  await updateNativeNode(j.assignedNode, (n) => {
    const score = Number(tokPerSec.toFixed(1));
    n.benchmark = { score, computeClass: classify(tokPerSec, n.reported.hardware.mock), basis: "coordinator-timed", at: now, firstByteMs, model: j.model };
  });
}
