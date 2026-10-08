import "server-only";
import { eventBus } from "@/services/eventBus";
import { cancelJob, createInferenceJob, getInferenceJob, matchJob, patchJob, type InferenceJob } from "./jobs";
import { CANARY_REQUESTER, VERIFY_REQUESTER, isProbeJob } from "./probes";
import { getNativeNode, updateNativeNode, type NativeNode } from "./registry";
import { disputeNativeWork, recordShadowWork } from "./work";

export { CANARY_REQUESTER, VERIFY_REQUESTER, isProbeJob, probeKind } from "./probes";

/**
 * Verification of node inference beyond the per-job checks (hash, stream consistency, timing).
 *
 * Two probes, both coordinator-initiated, both labelled on /network and /provider:
 *
 *  - Redundant execution. A sample of deterministic (temperature 0) customer jobs is re-run on a
 *    second node after the first completes. The two outputs are compared with a text-similarity
 *    heuristic (different GPUs and batch shapes make bit-identical output unrealistic even at
 *    temperature 0). A mismatch is recorded against BOTH nodes: with two parties the coordinator
 *    cannot know which one lied, so it lowers confidence in each and lets history sort it out, and
 *    the primary's work is unpaid. A match pays the shadow node as well: it ran the same real prompt
 *    and its answer was checked against another machine (services/coordinator/work.ts).
 *
 *  - Canaries. Fixed prompts with a mechanically checkable answer, sent to real nodes on a schedule.
 *    A node that fails two in a row is DEGRADED and leaves routing until it passes one. Unpaid: they
 *    are the coordinator's four questions, not work anyone asked for.
 *
 * Neither probe makes a receipt "verified". Receipts for node work stay `node-reported`; these
 * probes feed the node's reliability score, which is a routing input. Mock nodes are never
 * canaried (they return fixed text and are unclassified by design) and never shadow real jobs.
 */

/** Share of deterministic customer jobs that get a shadow run. Env-tunable; 0 disables. */
export const sampleRate = () => {
  const v = Number(process.env.BRAIN_VERIFY_SAMPLE_RATE);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.05;
};
/** Similarity at or above this counts as agreement. Heuristic; see `similarity`. */
export const MATCH_THRESHOLD = 0.8;
/** A real node gets a canary at least this often while online, and after this many completed jobs. */
export const CANARY_INTERVAL_MS = 60 * 60_000;
export const CANARY_EVERY_JOBS = 25;
/**
 * Canary deadline. Measured on a consumer card (RTX 4060, Qwen 1.5B): a node that has been idle
 * reloads weights for ~32 s before the first token, and 32 tokens follow at 1–60 tok/s. 60 s cut
 * off healthy nodes mid-reload and then counted that as a wrong answer.
 */
export const CANARY_TTL_MS = 180_000;

/**
 * Character 4-gram Jaccard similarity over whitespace-normalised, lower-cased text, blended with a
 * length ratio so a correct prefix followed by garbage does not pass. 1 = identical, 0 = unrelated.
 */
export function similarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  const grams = (s: string) => {
    const g = new Set<string>();
    if (s.length < 4) g.add(s);
    for (let i = 0; i + 4 <= s.length; i++) g.add(s.slice(i, i + 4));
    return g;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  const jaccard = inter / (gx.size + gy.size - inter);
  const lengthRatio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
  return Number((0.8 * jaccard + 0.2 * lengthRatio).toFixed(4));
}

export interface Canary {
  id: string;
  prompt: string;
  /** Pure check on the node's output. */
  check: (output: string) => boolean;
}

export const CANARIES: readonly Canary[] = [
  { id: "word", prompt: "Reply with exactly the single word PINEAPPLE in capital letters and nothing else.", check: (o) => /PINEAPPLE/.test(o) && o.trim().length <= 40 },
  { id: "sum", prompt: "What is 17 + 26? Reply with only the number.", check: (o) => /\b43\b/.test(o) && o.trim().length <= 20 },
  { id: "list", prompt: "List the three primary colours of light, comma separated, lowercase, nothing else.", check: (o) => /red/i.test(o) && /green/i.test(o) && /blue/i.test(o) && o.trim().length <= 60 },
  // A canary must be something every allowlisted model answers reliably, or it measures the model,
  // not the node. "Spell 'brain' backwards" was removed after an honest RTX 3060 running a 3B model
  // failed it: small models get letter-level tasks wrong routinely.
  { id: "capital", prompt: "What is the capital city of France? Reply with only the city name.", check: (o) => /paris/i.test(o) && o.trim().length <= 30 },
];

const pickCanary = (seed: number) => CANARIES[Math.abs(seed) % CANARIES.length];

/* ----------------------------------------------------------------------------------------------- */
/* Redundant execution                                                                              */
/* ----------------------------------------------------------------------------------------------- */

/**
 * After a customer job completes: maybe re-run it on a different node. Returns the shadow job when
 * one was dispatched. `force` bypasses the sample rate (tests, operator tooling).
 */
export async function maybeShadow(primaryJobId: string, now = Date.now(), force = false): Promise<InferenceJob | null> {
  try {
    const p = await getInferenceJob(primaryJobId);
    if (!p || p.state !== "COMPLETED" || isProbeJob(p) || p.verifyOf || p.verification) return null;
    if (p.request.temperature !== 0) return null;
    if (!p.assignedNode) return null;
    const primaryNode = await getNativeNode(p.assignedNode);
    if (!primaryNode || primaryNode.reported.hardware.mock) return null;
    if (!force && Math.random() >= sampleRate()) return null;
    const shadow = await createInferenceJob(
      {
        requesterId: VERIFY_REQUESTER,
        model: p.model,
        messages: p.request.messages,
        maxTokens: p.request.maxTokens,
        temperature: 0,
        ...(p.request.stop ? { stop: p.request.stop } : {}),
        region: p.requirements.region,
        exclude: [p.assignedNode],
        verifyOf: p.jobId,
        ttlMs: 120_000,
        idPrefix: "vj",
      },
      now,
    );
    const matched = await matchJob(shadow.jobId, now);
    if (matched.state !== "ASSIGNED") {
      // No second node right now. Do not leave a queued probe competing with customer traffic.
      await cancelJob(shadow.jobId, "no second node available for redundant execution", now);
      return null;
    }
    await patchJob(p.jobId, (j) => void (j.verification = { kind: "redundant", status: "pending", peerJobId: shadow.jobId, peerNodeId: matched.assignedNode, similarity: null }));
    return matched;
  } catch (e) {
    console.error("[verify] shadow scheduling failed", e);
    return null;
  }
}

/** Called after a shadow job reaches a terminal state. Compares and records against both nodes. */
export async function recordShadowResult(shadowJobId: string, now = Date.now()) {
  const s = await getInferenceJob(shadowJobId);
  if (!s || !s.verifyOf || s.requesterId !== VERIFY_REQUESTER) return;
  const p = await getInferenceJob(s.verifyOf);
  if (!p || !p.assignedNode) return;
  if (s.state !== "COMPLETED" || !s.assignedNode) {
    // The shadow failed; that says something about the shadow node, nothing about the primary.
    await patchJob(p.jobId, (j) => void (j.verification = { kind: "redundant", status: "inconclusive", peerJobId: s.jobId, peerNodeId: s.assignedNode, similarity: null }));
    return;
  }
  const sim = similarity(p.output, s.output);
  const matched = sim >= MATCH_THRESHOLD;
  const status = matched ? "matched" : "mismatched";
  await patchJob(p.jobId, (j) => void (j.verification = { kind: "redundant", status, peerJobId: s.jobId, peerNodeId: s.assignedNode, similarity: sim }));
  await patchJob(s.jobId, (j) => void (j.verification = { kind: "redundant", status, peerJobId: p.jobId, peerNodeId: p.assignedNode, similarity: sim }));
  const bump = (n: NativeNode) => {
    if (matched) n.measured.redundantMatched = (n.measured.redundantMatched ?? 0) + 1;
    else n.measured.redundantMismatched = (n.measured.redundantMismatched ?? 0) + 1;
  };
  await updateNativeNode(p.assignedNode, bump);
  await updateNativeNode(s.assignedNode, bump);
  // Two nodes disagreed and the coordinator cannot say which was right: the primary's work is unpaid.
  // Two nodes agreed: the shadow did the same real work under a stricter check, and settles too.
  if (!matched) await disputeNativeWork(p.jobId);
  else await recordShadowWork(s);
  eventBus.publish({ type: "nverify.result", at: now, kind: "redundant", jobId: p.jobId, nodeIds: [p.assignedNode, s.assignedNode], passed: matched, detail: `similarity ${sim}` });
}

/* ----------------------------------------------------------------------------------------------- */
/* Canaries                                                                                         */
/* ----------------------------------------------------------------------------------------------- */

const canaryDue = (n: NativeNode, now: number) => {
  if (n.reported.hardware.mock) return false;
  if (n.state !== "ONLINE" && !(n.state === "DEGRADED" && (n.measured.canaryFailStreak ?? 0) >= 2)) return false;
  if (n.activeJobIds.some((id) => id.startsWith("cj-"))) return false;
  // A node at capacity cannot start the canary; it would sit ASSIGNED until the deadline and be
  // blamed for it. Ask again when it has a free slot.
  if (n.activeJobIds.length >= n.reported.capabilities.maxConcurrency) return false;
  const last = n.lastCanaryAt ?? 0;
  const since = n.measured.jobsCompleted - (n.jobsAtLastCanary ?? 0);
  // A node degraded by canaries gets another chance every 5 minutes; otherwise hourly or per N jobs.
  if ((n.measured.canaryFailStreak ?? 0) >= 2) return now - last > 5 * 60_000;
  return last === 0 || now - last > CANARY_INTERVAL_MS || since >= CANARY_EVERY_JOBS;
};

/** Sends a canary to the node when one is due. Idempotent while one is pending. */
export async function scheduleCanary(nodeId: string, now = Date.now(), force = false): Promise<InferenceJob | null> {
  try {
    const n = await getNativeNode(nodeId);
    if (!n || (!force && !canaryDue(n, now)) || n.reported.hardware.mock) return null;
    const model = n.reported.capabilities.supportedModels[0];
    if (!model) return null;
    const canary = pickCanary(Math.floor(now / 1000) + n.nodeId.charCodeAt(2));
    const job = await createInferenceJob(
      { requesterId: CANARY_REQUESTER, model, messages: [{ role: "user", content: canary.prompt }], maxTokens: 32, temperature: 0, pinnedNode: nodeId, allowDegraded: true, ttlMs: CANARY_TTL_MS, idPrefix: "cj", canaryId: canary.id },
      now,
    );
    const matched = await matchJob(job.jobId, now);
    if (matched.state !== "ASSIGNED") {
      await cancelJob(job.jobId, "node not available for canary", now);
      return null;
    }
    await updateNativeNode(nodeId, (x) => {
      x.lastCanaryAt = now;
      x.jobsAtLastCanary = x.measured.jobsCompleted;
    });
    return matched;
  } catch (e) {
    console.error("[verify] canary scheduling failed", e);
    return null;
  }
}

/** Called after a canary job reaches a terminal state. */
export async function recordCanary(jobId: string, now = Date.now()) {
  const j = await getInferenceJob(jobId);
  if (!j || j.requesterId !== CANARY_REQUESTER || !j.assignedNode || !j.canaryId) return;
  const canary = CANARIES.find((c) => c.id === j.canaryId);
  const passed = j.state === "COMPLETED" && Boolean(canary?.check(j.output));
  // A canary asks whether the node answers correctly. A timeout says nothing about that: the node
  // was slow or busy, which fail() has already charged to its reliability (jobsTimedOut,
  // consecutiveFailures). Counting it here as well would make slowness a second, separate offence
  // and send honest cold nodes to DEGRADED. It is retried on the next schedule.
  const inconclusive = !passed && j.state === "FAILED" && j.failureReason === "timeout";
  await patchJob(j.jobId, (x) => void (x.verification = { kind: "canary", status: passed ? "passed" : inconclusive ? "inconclusive" : "failed", canaryId: j.canaryId!, similarity: null }));
  await updateNativeNode(j.assignedNode, (n) => {
    if (inconclusive) return;
    if (passed) {
      n.measured.canaryPassed = (n.measured.canaryPassed ?? 0) + 1;
      n.measured.canaryFailStreak = 0;
    } else {
      n.measured.canaryFailed = (n.measured.canaryFailed ?? 0) + 1;
      n.measured.canaryFailStreak = (n.measured.canaryFailStreak ?? 0) + 1;
    }
  });
  eventBus.publish({ type: "nverify.result", at: now, kind: "canary", jobId: j.jobId, nodeIds: [j.assignedNode], passed, detail: inconclusive ? `canary ${j.canaryId} timed out (inconclusive)` : `canary ${j.canaryId}` });
}
