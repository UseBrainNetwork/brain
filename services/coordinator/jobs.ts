import "server-only";
import type { Money } from "@/domain/economy";
import { modelSpec } from "@/node/models";
import { DEFAULTS, type Backend, type ChatTurn, type CompletedBody, type FailedBody, type JobPayload, type JobState, type ProgressBody, type StartedBody } from "@/node/protocol";
import { eventBus } from "@/services/eventBus";
import { NodeError } from "@/services/nodes";
import { routeToNativeNode } from "@/services/router/select";
import { sha256, token } from "@/services/security";
import { getStore } from "@/services/store";
import { updateNativeNode } from "./registry";
import { issueNodeReceipt } from "./receipts";

/**
 * Inference job state machine for native Brain Nodes.
 *
 *   QUEUED → MATCHING → ASSIGNED → STARTING → RUNNING → VERIFYING → COMPLETED
 *                 ↘ QUEUED (no node yet / node did not start: re-match)      ↘ FAILED
 *   any non-terminal → CANCELLED
 *
 * Every transition is checked against TRANSITIONS and appended to `history`, so a job page can
 * show exactly what happened and when (coordinator clock). The record is the source of truth;
 * the event bus is only a fast path for the instance that happens to hold the streaming request.
 */
export const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  QUEUED: ["MATCHING", "CANCELLED", "FAILED"],
  MATCHING: ["ASSIGNED", "QUEUED", "FAILED", "CANCELLED"],
  ASSIGNED: ["STARTING", "RUNNING", "QUEUED", "FAILED", "CANCELLED"],
  STARTING: ["RUNNING", "QUEUED", "FAILED", "CANCELLED"],
  RUNNING: ["VERIFYING", "FAILED", "CANCELLED"],
  VERIFYING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const TERMINAL: ReadonlySet<JobState> = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export interface InferenceJob {
  jobId: string;
  requesterId: string;
  model: string;
  requirements: { minVramMb: number | null; region: string | null };
  request: { messages: ChatTurn[]; maxTokens: number; temperature: number; stop?: string[] };
  /** sha256 of the canonical request (model + messages + sampling). */
  requestHash: string;
  state: JobState;
  history: { state: JobState; at: number; note?: string }[];
  assignedNode: string | null;
  attempts: number;
  excludedNodes: string[];
  routing: { reason: string; eligible: number; considered: number } | null;
  createdAt: number;
  assignedAt: number | null;
  startedAt: number | null;
  firstByteAt: number | null;
  lastProgressAt: number | null;
  completedAt: number | null;
  deadlineAt: number;
  /** Streamed output so far; `seq` is the number of progress frames accepted. */
  output: string;
  seq: number;
  finishReason: CompletedBody["finishReason"] | null;
  tokenUsage: { prompt: number; completion: number; basis: "node-reported" } | null;
  /** Coordinator-timed: first progress (or start) → completion. */
  computeDurationMs: number | null;
  nodeReportedDurationMs: number | null;
  failureReason: string | null;
  estimatedCost: Money | null;
  finalCost: Money | null;
  responseHash: string | null;
  receiptId: string | null;
  backend: Backend | null;
  modelLoaded: boolean | null;
  orderId?: string;
  decisionId?: string;
}

/** Job as shown publicly: no prompt, no output text, lengths only. */
export type PublicInferenceJob = Omit<InferenceJob, "request" | "output" | "requesterId"> & { request: { messages: number; chars: number; maxTokens: number }; outputChars: number };

export function publicInferenceJob(j: InferenceJob): PublicInferenceJob {
  const { request, output, requesterId: _r, ...rest } = j;
  void _r;
  return { ...rest, request: { messages: request.messages.length, chars: request.messages.reduce((s, m) => s + m.content.length, 0), maxTokens: request.maxTokens }, outputChars: output.length };
}

const KIND = "njob" as const;
const store = () => getStore();
const indexKey = (j: InferenceJob) => (j.assignedNode && !TERMINAL.has(j.state) ? `node:${j.assignedNode}` : `state:${j.state}`);
const save = (j: InferenceJob) => store().putDoc(KIND, j.jobId, j, { at: j.createdAt, key: indexKey(j) });
export const getInferenceJob = (id: string) => store().getDoc<InferenceJob>(KIND, id);
export const listInferenceJobs = (limit = 50) => store().listDocs<InferenceJob>(KIND, { limit });

export const canonicalRequest = (r: InferenceJob["request"] & { model: string }) =>
  JSON.stringify({ model: r.model, messages: r.messages.map((m) => ({ role: m.role, content: m.content })), maxTokens: r.maxTokens, temperature: r.temperature, stop: r.stop ?? [] });

/** Pure transition. Throws on an illegal edge so a bug cannot silently corrupt history. */
export function transition(j: InferenceJob, to: JobState, now: number, note?: string): InferenceJob {
  if (!TRANSITIONS[j.state].includes(to)) throw new NodeError(`illegal_transition:${j.state}->${to}`, 409);
  j.state = to;
  j.history.push({ state: to, at: now, ...(note ? { note } : {}) });
  return j;
}

const publish = (j: InferenceJob, at: number) => eventBus.publish({ type: "njob.updated", at, job: publicInferenceJob(j) });

/**
 * Node-record updates are deferred until the job lock is released. Postgres advisory locks pin a
 * client each; nesting job → node locks under a small lock pool could exhaust it and hang.
 */
type After = (() => Promise<unknown>)[];
async function locked<T>(jobId: string, fn: (after: After) => Promise<T>): Promise<T> {
  const after: After = [];
  const out = await store().withLock(`njob:${jobId}`, () => fn(after));
  for (const f of after) await f().catch((e) => console.error("[coordinator] deferred node update failed", e));
  return out;
}

export interface CreateJobInput {
  requesterId: string;
  model: string;
  messages: ChatTurn[];
  maxTokens: number;
  temperature: number;
  stop?: string[];
  region?: string | null;
  estimatedCost?: Money | null;
  orderId?: string;
  decisionId?: string;
  /** Hard ceiling on wall time; default 120 s. */
  ttlMs?: number;
}

export async function createInferenceJob(input: CreateJobInput, now = Date.now()): Promise<InferenceJob> {
  const spec = modelSpec(input.model);
  if (!spec) throw new NodeError("model_not_allowlisted", 404);
  const request = { messages: input.messages, maxTokens: input.maxTokens, temperature: input.temperature, ...(input.stop?.length ? { stop: input.stop } : {}) };
  const j: InferenceJob = {
    jobId: `ij-${now.toString(36)}-${token(4)}`,
    requesterId: input.requesterId,
    model: input.model,
    requirements: { minVramMb: spec.minVramMb || null, region: input.region ?? null },
    request,
    requestHash: sha256(canonicalRequest({ ...request, model: input.model })),
    state: "QUEUED",
    history: [{ state: "QUEUED", at: now }],
    assignedNode: null,
    attempts: 0,
    excludedNodes: [],
    routing: null,
    createdAt: now,
    assignedAt: null,
    startedAt: null,
    firstByteAt: null,
    lastProgressAt: null,
    completedAt: null,
    deadlineAt: now + (input.ttlMs ?? 120_000),
    output: "",
    seq: 0,
    finishReason: null,
    tokenUsage: null,
    computeDurationMs: null,
    nodeReportedDurationMs: null,
    failureReason: null,
    estimatedCost: input.estimatedCost ?? null,
    finalCost: null,
    responseHash: null,
    receiptId: null,
    backend: null,
    modelLoaded: null,
    ...(input.orderId ? { orderId: input.orderId } : {}),
    ...(input.decisionId ? { decisionId: input.decisionId } : {}),
  };
  await save(j);
  publish(j, now);
  return j;
}

/**
 * QUEUED → MATCHING → ASSIGNED, or back to QUEUED with the capacity reason when nothing is
 * eligible (the caller decides whether to wait or fail). Never picks a node outside the router.
 */
export async function matchJob(jobId: string, now = Date.now()): Promise<InferenceJob> {
  return locked(jobId, async (after) => {
    const j = await getInferenceJob(jobId);
    if (!j) throw new NodeError("unknown_job", 404);
    if (j.state !== "QUEUED") return j;
    transition(j, "MATCHING", now);
    const r = await routeToNativeNode(j.model, { region: j.requirements.region, exclude: j.excludedNodes }, now);
    j.routing = { reason: r.reason, eligible: r.ranked.filter((x) => x.eligible).length, considered: r.ranked.length };
    if (!r.selected) {
      transition(j, "QUEUED", now, r.reason);
      await save(j);
      publish(j, now);
      return j;
    }
    j.assignedNode = r.selected.nodeId;
    j.assignedAt = now;
    j.attempts++;
    transition(j, "ASSIGNED", now, r.reason);
    await save(j);
    const nodeId = j.assignedNode;
    after.push(() =>
      updateNativeNode(nodeId, (n) => {
        if (!n.activeJobIds.includes(j.jobId)) n.activeJobIds.push(j.jobId);
      }),
    );
    publish(j, now);
    eventBus.publish({ type: "njob.assigned", at: now, jobId: j.jobId, nodeId: j.assignedNode });
    return j;
  });
}

/** Fails a job outright with a capacity reason (used when the gateway will not wait). */
export async function failUnmatched(jobId: string, reason: string, now = Date.now()) {
  return locked(jobId, async () => {
    const j = await getInferenceJob(jobId);
    if (!j || j.state !== "QUEUED") return j;
    j.failureReason = reason;
    j.completedAt = now;
    transition(j, "FAILED", now, reason);
    await save(j);
    publish(j, now);
    return j;
  });
}

const payloadOf = (j: InferenceJob): JobPayload => ({ jobId: j.jobId, model: j.model, messages: j.request.messages, maxTokens: j.request.maxTokens, temperature: j.request.temperature, ...(j.request.stop ? { stop: j.request.stop } : {}), deadlineAt: j.deadlineAt, flushMs: DEFAULTS.flushMs });

/**
 * Work delivery. Returns the oldest ASSIGNED job for the node, waiting up to `waitMs` for one to
 * appear (event bus on this instance, store re-check every 2 s for other instances).
 */
export async function nextWorkFor(nodeId: string, waitMs: number, now = Date.now()): Promise<JobPayload | null> {
  const find = async () => {
    const mine = await store().listDocs<InferenceJob>(KIND, { key: `node:${nodeId}`, limit: 10 });
    return mine.filter((j) => j.state === "ASSIGNED").sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
  };
  let j = await find();
  const deadline = now + Math.max(0, Math.min(waitMs, DEFAULTS.workPollMs));
  while (!j && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, Math.min(2_000, Math.max(0, deadline - Date.now())));
      const off = eventBus.subscribe((e) => {
        if (e.type === "njob.assigned" && e.nodeId === nodeId) done();
      });
      function done() {
        clearTimeout(t);
        off();
        resolve();
      }
    });
    j = await find();
  }
  return j ? payloadOf(j) : null;
}

async function owned(jobId: string, nodeId: string) {
  const j = await getInferenceJob(jobId);
  if (!j) throw new NodeError("unknown_job", 404);
  if (j.assignedNode !== nodeId) throw new NodeError("not_your_job", 403);
  return j;
}

export async function reportStarted(nodeId: string, jobId: string, body: StartedBody, now = Date.now()) {
  return locked(jobId, async () => {
    const j = await owned(jobId, nodeId);
    if (j.state !== "ASSIGNED") return j;
    j.backend = body.backend === "vllm" ? "vllm" : "mock";
    j.modelLoaded = body.loaded === true;
    j.startedAt = now;
    transition(j, "STARTING", now, body.loaded ? "model loaded on demand" : undefined);
    await save(j);
    publish(j, now);
    return j;
  });
}

const MAX_OUTPUT_CHARS = 200_000;

export async function reportProgress(nodeId: string, jobId: string, body: ProgressBody, now = Date.now()) {
  return locked(jobId, async (after) => {
    const j = await owned(jobId, nodeId);
    if (TERMINAL.has(j.state)) return j;
    if (j.state === "VERIFYING") throw new NodeError("already_completed", 409);
    if (typeof body.delta !== "string" || !Number.isInteger(body.seq)) throw new NodeError("bad_progress", 400);
    if (body.seq !== j.seq) throw new NodeError(`bad_seq:expected ${j.seq}`, 409);
    if (j.output.length + body.delta.length > MAX_OUTPUT_CHARS) return fail(j, "output_too_large", "node exceeded output cap", now, false, after);
    if (j.state === "ASSIGNED") {
      j.startedAt = now;
      transition(j, "STARTING", now, "progress before start report");
    }
    if (j.state === "STARTING") {
      j.firstByteAt = now;
      transition(j, "RUNNING", now);
    }
    j.output += body.delta;
    j.seq++;
    j.lastProgressAt = now;
    await save(j);
    eventBus.publish({ type: "njob.progress", at: now, jobId: j.jobId, nodeId, seq: j.seq, delta: body.delta, outputChars: j.output.length });
    return j;
  });
}

async function fail(j: InferenceJob, reason: string, note: string | undefined, now: number, timedOut: boolean, after: After) {
  j.failureReason = reason;
  j.completedAt = now;
  transition(j, "FAILED", now, note);
  await save(j);
  const nodeId = j.assignedNode;
  if (nodeId) {
    after.push(() =>
      updateNativeNode(nodeId, (n) => {
        n.activeJobIds = n.activeJobIds.filter((id) => id !== j.jobId);
        if (timedOut) n.measured.jobsTimedOut++;
        else n.measured.jobsFailed++;
        n.measured.consecutiveFailures++;
      }),
    );
  }
  publish(j, now);
  return j;
}

export async function reportFailed(nodeId: string, jobId: string, body: FailedBody, now = Date.now()) {
  return locked(jobId, async (after) => {
    const j = await owned(jobId, nodeId);
    if (TERMINAL.has(j.state)) return j;
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 32) : "backend_error";
    const detail = typeof body.detail === "string" ? body.detail.slice(0, 200) : undefined;
    // A node that cannot serve the model right now gets excluded and the job re-matched once.
    if (reason === "model_unavailable" && j.output.length === 0 && j.attempts < DEFAULTS.maxAttempts && (j.state === "ASSIGNED" || j.state === "STARTING")) {
      return requeue(j, nodeId, `node reported ${reason}`, now, after);
    }
    return fail(j, reason, detail, now, reason === "timeout", after);
  });
}

async function requeue(j: InferenceJob, fromNode: string, note: string, now: number, after: After) {
  j.excludedNodes.push(fromNode);
  j.assignedNode = null;
  j.assignedAt = null;
  j.startedAt = null;
  j.backend = null;
  transition(j, "QUEUED", now, note);
  await save(j);
  after.push(() =>
    updateNativeNode(fromNode, (n) => {
      n.activeJobIds = n.activeJobIds.filter((id) => id !== j.jobId);
    }),
  );
  publish(j, now);
  return j;
}

/**
 * RUNNING → VERIFYING → COMPLETED. "Verifying" here is what the coordinator can actually check
 * without running the model: the response hash matches the text, the final text equals what was
 * streamed, token counts are plausible for the text and the limit, and the node's claimed duration
 * does not exceed the wall time we observed. It is NOT a proof the right model ran; receipts say so.
 */
export async function reportCompleted(nodeId: string, jobId: string, body: CompletedBody, now = Date.now()) {
  return locked(jobId, async (after) => {
    const j = await owned(jobId, nodeId);
    if (TERMINAL.has(j.state)) return j;
    if (j.state === "ASSIGNED" || j.state === "STARTING") {
      // A node may finish without streaming (non-stream backends). Treat the whole text as one frame.
      if (j.state === "ASSIGNED") {
        j.startedAt = now;
        transition(j, "STARTING", now);
      }
      j.firstByteAt = now;
      transition(j, "RUNNING", now);
    }
    transition(j, "VERIFYING", now);
    const content = typeof body.content === "string" ? body.content : "";
    const problems: string[] = [];
    if (sha256(content) !== body.responseHash) problems.push("response hash mismatch");
    if (j.output.length && content !== j.output) problems.push("final text differs from streamed text");
    if (content.length > MAX_OUTPUT_CHARS) problems.push("output too large");
    const completion = Number(body.usage?.completion);
    const prompt = Number(body.usage?.prompt);
    if (!Number.isFinite(completion) || !Number.isFinite(prompt) || completion < 0 || prompt < 0) problems.push("token usage missing");
    else {
      if (completion > j.request.maxTokens + 16) problems.push("completion tokens exceed max_tokens");
      if (content.length > 0 && completion === 0) problems.push("zero completion tokens for non-empty output");
      if (completion > content.length + 16) problems.push("more tokens than characters");
    }
    const wall = now - (j.startedAt ?? j.assignedAt ?? j.createdAt);
    const nodeMs = Number(body.durationMs);
    if (Number.isFinite(nodeMs) && nodeMs > wall + 2_000) problems.push("claimed duration exceeds observed wall time");
    if (problems.length) return fail(j, "verification_failed", problems.join("; "), now, false, after);

    j.output = content;
    j.finishReason = body.finishReason === "length" || body.finishReason === "cancelled" ? body.finishReason : "stop";
    j.tokenUsage = { prompt, completion, basis: "node-reported" };
    j.nodeReportedDurationMs = Number.isFinite(nodeMs) ? nodeMs : null;
    j.computeDurationMs = Math.max(1, now - (j.firstByteAt ?? j.startedAt ?? now));
    j.completedAt = now;
    j.responseHash = body.responseHash;
    transition(j, "COMPLETED", now);
    const receipt = await issueNodeReceipt(j, now);
    j.receiptId = receipt.receiptId;
    j.finalCost = receipt.customerCost;
    await save(j);
    const tokPerSec = completion / Math.max(0.001, (j.computeDurationMs ?? 1) / 1000);
    const firstByte = j.firstByteAt && j.assignedAt ? j.firstByteAt - j.assignedAt : null;
    const durationMs = j.computeDurationMs ?? 0;
    after.push(() =>
      updateNativeNode(nodeId, (n) => {
        n.activeJobIds = n.activeJobIds.filter((id) => id !== j.jobId);
        n.measured.jobsCompleted++;
        n.measured.tokensGenerated += completion;
        n.measured.computeMs += durationMs;
        n.measured.consecutiveFailures = 0;
        n.measured.tokPerSec = [...n.measured.tokPerSec, Number(tokPerSec.toFixed(2))].slice(-20);
        if (firstByte != null) n.measured.firstByteMs = [...n.measured.firstByteMs, firstByte].slice(-20);
      }),
    );
    publish(j, now);
    return j;
  });
}

export async function cancelJob(jobId: string, reason = "cancelled by requester", now = Date.now()) {
  return locked(jobId, async (after) => {
    const j = await getInferenceJob(jobId);
    if (!j || TERMINAL.has(j.state) || j.state === "VERIFYING") return j;
    j.failureReason = reason;
    j.completedAt = now;
    transition(j, "CANCELLED", now, reason);
    await save(j);
    const nodeId = j.assignedNode;
    if (nodeId) after.push(() => updateNativeNode(nodeId, (n) => void (n.activeJobIds = n.activeJobIds.filter((id) => id !== j.jobId))));
    publish(j, now);
    return j;
  });
}

/**
 * Timeouts. ASSIGNED too long → re-match or fail; RUNNING without progress → fail; past deadline →
 * fail. Throttled per instance; called from work polls and job reads so it runs without a cron.
 */
const sweepAt = globalThis as typeof globalThis & { __brainNJobSweep?: number };
export async function sweepInferenceJobs(now = Date.now()) {
  if (now - (sweepAt.__brainNJobSweep ?? 0) < 5_000) return;
  sweepAt.__brainNJobSweep = now;
  const open = (await listInferenceJobs(100)).filter((j) => !TERMINAL.has(j.state));
  for (const o of open) {
    const rematch = await locked(o.jobId, async (after) => {
      const j = await getInferenceJob(o.jobId);
      if (!j || TERMINAL.has(j.state)) return false;
      if (now > j.deadlineAt) {
        await fail(j, "timeout", "deadline passed", now, true, after);
        return false;
      }
      if ((j.state === "ASSIGNED" || j.state === "STARTING") && j.assignedAt && now - j.assignedAt > DEFAULTS.startWithinMs) {
        if (j.attempts < DEFAULTS.maxAttempts && j.assignedNode) {
          await requeue(j, j.assignedNode, "node did not start in time", now, after);
          return true;
        }
        await fail(j, "timeout", "node did not start in time", now, true, after);
        return false;
      }
      if (j.state === "RUNNING") {
        const last = Math.max(j.lastProgressAt ?? 0, j.firstByteAt ?? 0, j.startedAt ?? j.createdAt);
        if (now - last > DEFAULTS.stallAfterMs) await fail(j, "timeout", "no progress", now, true, after);
      }
      return false;
    });
    if (rematch) await matchJob(o.jobId, now).catch(() => undefined);
  }
}

/**
 * Follows a job until it is terminal, yielding output deltas as they arrive. Fast path: progress
 * events on this instance. Slow path: re-read the record every `pollMs` so a request served by
 * another instance still streams (coarser, but correct). `signal` aborts the wait, not the job.
 */
export async function* observeJob(jobId: string, opts: { pollMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<{ job: InferenceJob; delta: string }> {
  const pollMs = opts.pollMs ?? 600;
  let sent = 0;
  let wake: (() => void) | null = null;
  const pendingDeltas: string[] = [];
  const off = eventBus.subscribe((e) => {
    if ((e.type === "njob.progress" || e.type === "njob.updated") && (e.type === "njob.progress" ? e.jobId : e.job.jobId) === jobId) {
      if (e.type === "njob.progress") pendingDeltas.push(e.delta);
      wake?.();
    }
  });
  try {
    let job = await getInferenceJob(jobId);
    if (!job) return;
    for (;;) {
      // Prefer the authoritative record for text; events only tell us when to look.
      const fresh = await getInferenceJob(jobId);
      if (fresh) job = fresh;
      if (job.output.length > sent) {
        const delta = job.output.slice(sent);
        sent = job.output.length;
        pendingDeltas.length = 0;
        yield { job, delta };
      } else if (pendingDeltas.length) {
        // Record lagging behind the bus (another write in flight): surface the bus text now, reconcile on the next read.
        const delta = pendingDeltas.join("");
        pendingDeltas.length = 0;
        sent += delta.length;
        yield { job, delta };
      }
      if (TERMINAL.has(job.state)) {
        // Always yield the terminal record (possibly with an empty delta) so callers see the final state.
        yield { job, delta: job.output.length > sent ? job.output.slice(sent) : "" };
        return;
      }
      if (opts.signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        wake = () => {
          clearTimeout(t);
          wake = null;
          resolve();
        };
      });
    }
  } finally {
    off();
  }
}

export async function getInferenceJobPublic(id: string) {
  const j = await getInferenceJob(id);
  return j ? publicInferenceJob(j) : null;
}
