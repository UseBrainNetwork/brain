import type { DistributedJob, DistributedJobStatus, WorkUnit, WorkloadSize } from "@/domain/types";
import { networkConfig } from "@/lib/config";
import { workloadUnits, type WorkloadResult, type WorkloadSpec } from "@/network/workloads";
import { eventBus } from "./eventBus";
import { retryOnConflict } from "./failsoft";
import { issueReceipt } from "./receipts";
import { NodeError } from "./nodes";
import { sampleIndices, secureU32 } from "./security";
import { getStore, type StoredJob, type StoredNode } from "./store";
import { compareRedundant } from "./verification";

/**
 * Distributed jobs: ONE request, split into N work units, executed on REAL browser nodes,
 * verified on this server. Each work unit is an ordinary StoredJob (so dispatch, deadlines,
 * spot-check verification, reputation and settlement all apply unchanged) tagged with
 * `parentId`. This module owns the parent record and its state machine.
 *
 * What is computed (honestly): wrapping-u32 matrix multiplication. Every unit multiplies a
 * distinct seeded row block A_i (m×k) by a shared seeded matrix B (k×n) and returns one FNV-1a
 * hash per output row. The server recomputes secret rows to verify. This is a Level-1
 * parallel tensor workload — the same primitive attention and MLP layers are built from —
 * and is labeled as such. It is NOT model inference.
 */

const cfg = networkConfig.distributed;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const WORKLOAD = {
  kind: "matmul_u32" as const,
  label: "Parallel integer matmul",
  description: "Each work unit computes a row block of C = A × B in wrapping u32 arithmetic on the node's GPU and returns a hash per output row. Not model inference.",
};

const unitLabel = (i: number) => (i < 26 ? LETTERS[i] : `${LETTERS[Math.floor(i / 26) - 1]}${LETTERS[i % 26]}`);

export interface CreateJobInput {
  size?: WorkloadSize;
  unitsPerNode?: number;
  redundancy?: 1 | 2;
  /** Tests only: override dims so CPU references stay cheap. */
  dims?: { m: number; n: number; k: number };
  /** Set by the routing engine when the job fulfils a compute order. */
  orderId?: string;
  decisionId?: string;
  /** Compute attached to a completed chat/inference request. Runs alongside other jobs; never blocks or is blocked by them. */
  attachedTo?: DistributedJob["attachedTo"];
  /** Upper bound on nodes used (attached jobs spread thin on purpose). */
  maxNodes?: number;
  /** Operator-scheduled baseline work. Runs alongside other jobs like attached compute. */
  scheduled?: DistributedJob["scheduled"];
}

const live = (n: StoredNode) => n.status === "idle" || n.status === "computing";

function unitSpec(dims: { m: number; n: number; k: number }, seedB: number): WorkloadSpec {
  return { kernel: "matmul_u32", m: dims.m, n: dims.n, k: dims.k, seedA: secureU32(), seedB };
}

/** Confidence that spot-checking `rows` secret rows catches a node that skipped ≥25% of them. */
const spotConfidence = (rows: number) => 1 - Math.pow(0.75, rows);

/**
 * Attached jobs have nobody waiting on them, and nodes poll for work on a paced interval (up to ~30 s
 * between polls). Their units therefore get a deadline that covers pickup latency plus compute, and
 * the job as a whole gets a longer life, instead of the interactive demo's tight numbers.
 */
const ATTACHED_UNIT_DEADLINE_MS = 90_000;
const ATTACHED_JOB_TTL_MS = 10 * 60_000;
/** Background work (attached, scheduled) is not interactive: it gets patient deadlines so slow pollers still count. */
const relaxed = (job: DistributedJob) => Boolean(job.attachedTo || job.scheduled);
export const unitDeadlineMs = (job: DistributedJob) => (relaxed(job) ? ATTACHED_UNIT_DEADLINE_MS : cfg.unitDeadlineMs);
export const jobTtlMs = (job: DistributedJob) => (relaxed(job) ? ATTACHED_JOB_TTL_MS : cfg.jobTtlMs);

function makeUnitJob(parent: DistributedJob, unit: WorkUnit, spec: WorkloadSpec, now: number): StoredJob {
  const rows = spec.kernel === "matmul_u32" ? spec.m : 0;
  return {
    id: unit.id,
    model: `${WORKLOAD.label} ${parent.workload.unitDims.m}×${parent.workload.unitDims.n}×${parent.workload.unitDims.k}`,
    kind: "tensor",
    status: "assigned",
    nodeIds: [unit.nodeId],
    workUnits: 1,
    computeUnits: workloadUnits(spec),
    submittedAt: now,
    lifecycle: [
      { stage: "submitted", at: parent.createdAt },
      { stage: "split", at: now, detail: `unit ${unit.label} of ${parent.totals.workUnits}` },
      { stage: "assigned", at: now, detail: `node ${unit.nodeId}` },
    ],
    provenance: "live",
    spec,
    assignedTo: unit.nodeId,
    issuedAt: now,
    deadline: now + unitDeadlineMs(parent),
    canary: false,
    sampleIndices: sampleIndices(rows, cfg.sampledRows),
    parentId: parent.id,
    unitId: unit.id,
  };
}

function recomputeTotals(job: DistributedJob) {
  const t = job.totals;
  t.verified = job.units.filter((u) => u.status === "verified").length;
  t.failed = job.units.filter((u) => u.status === "mismatch" || u.status === "failed").length;
  t.reassigned = job.units.filter((u) => u.replacedUnitId).length;
  t.computeUnits = job.units.filter((u) => u.status === "verified").reduce((s, u) => s + u.computeUnits, 0);
  t.nodesUsed = new Set(job.units.filter((u) => u.status === "verified").map((u) => u.nodeId)).size;
  job.nodeIds = [...new Set(job.units.map((u) => u.nodeId))];
}

function setStatus(job: DistributedJob, status: DistributedJobStatus, at: number, detail?: string) {
  if (job.status === status) return;
  job.status = status;
  job.lifecycle.push({ stage: status, at, detail });
}

/** Logical slots = distinct (index, replica) pairs. A slot is done when some attempt for it verified. */
function slotDone(job: DistributedJob, index: number, replica: number) {
  return job.units.some((u) => u.index === index && u.replica === replica && u.status === "verified");
}
function slotOpen(job: DistributedJob, index: number, replica: number) {
  return job.units.some((u) => u.index === index && u.replica === replica && (u.status === "assigned" || u.status === "computing" || u.status === "returned"));
}

/** The in-flight interactive (demo / compute-order) job, if any. Attached and scheduled jobs are excluded: they run concurrently. */
export async function activeJob(): Promise<DistributedJob | null> {
  const now = Date.now();
  for (const j of await getStore().listDistributedJobs(20)) {
    if (j.attachedTo || j.scheduled) continue;
    if (j.status !== "completed" && j.status !== "failed" && now - j.createdAt < jobTtlMs(j)) return j;
  }
  return null;
}

export function createJob(input: CreateJobInput = {}): Promise<DistributedJob> {
  return getStore().withLock("djob:create", () => createJobUnlocked(input));
}

async function createJobUnlocked(input: CreateJobInput): Promise<DistributedJob> {
  const store = getStore();
  if (!input.attachedTo && !input.scheduled && (await activeJob())) throw new NodeError("job_in_progress", 409);
  let nodes = (await store.listNodes()).filter(live).sort((a, b) => b.computeScore - a.computeScore);
  if (nodes.length === 0) throw new NodeError("no_real_nodes", 409);
  if (input.maxNodes && input.maxNodes > 0 && nodes.length > input.maxNodes) {
    // Attached jobs rotate through the fleet rather than always landing on the strongest nodes.
    const offset = Math.floor(Math.random() * nodes.length);
    nodes = Array.from({ length: input.maxNodes }, (_, i) => nodes[(offset + i) % nodes.length]);
  }

  const size: WorkloadSize = input.size && input.size in cfg.sizes ? input.size : "medium";
  const dims = input.dims ?? cfg.sizes[size];
  const perNode = Math.min(16, Math.max(1, Math.round(input.unitsPerNode ?? cfg.defaultUnitsPerNode)));
  const redundancy: 1 | 2 = input.redundancy === 2 && nodes.length >= 2 ? 2 : 1;
  const unitCount = Math.min(cfg.maxUnits, nodes.length * perNode);
  const now = Date.now();
  const id = String(await store.nextJobNumber());
  const seedB = secureU32();

  const job: DistributedJob = {
    id,
    workload: { ...WORKLOAD, unitDims: dims },
    size,
    status: "queued",
    redundancy,
    createdAt: now,
    units: [],
    nodeIds: [],
    totals: { workUnits: unitCount, verified: 0, failed: 0, reassigned: 0, computeUnits: 0, nodesUsed: 0 },
    source: "real",
    orderId: input.orderId,
    decisionId: input.decisionId,
    attachedTo: input.attachedTo,
    scheduled: input.scheduled,
    lifecycle: [{ stage: "queued", at: now, detail: `${unitCount} work units · ${nodes.length} real nodes${input.attachedTo ? ` · attached to ${input.attachedTo.orderId}` : ""}${input.scheduled ? ` · scheduled by operator (${input.scheduled.reason})` : ""}` }],
  };
  await store.saveDistributedJob(job);
  eventBus.publish({ type: "djob.created", at: now, job: structuredClone(job) });

  setStatus(job, "assigning", now);
  // Round-robin by index; replicas go to a different node than the primary.
  for (let i = 0; i < unitCount; i++) {
    const spec = unitSpec(dims, seedB);
    for (let r = 0; r < redundancy; r++) {
      const node = nodes[(i + r) % nodes.length];
      const unit: WorkUnit = {
        id: `${id}-${unitLabel(i)}${r ? `'${r}` : ""}`,
        index: i,
        label: unitLabel(i),
        nodeId: node.id,
        status: "assigned",
        attempt: 1,
        replica: r,
        assignedAt: now,
        computeUnits: workloadUnits(spec),
      };
      job.units.push(unit);
      await store.saveJob(makeUnitJob(job, unit, spec, now));
    }
  }
  for (const n of nodes) await store.saveNode({ ...n, status: "computing" });
  recomputeTotals(job);
  setStatus(job, "distributed", Date.now(), `${job.units.length} units on ${nodes.length} nodes`);
  await store.saveDistributedJob(job);
  eventBus.publish({ type: "djob.assigned", at: Date.now(), job: structuredClone(job) });
  return job;
}

/** Node reports it began executing a unit. Display-only; verification never trusts it. */
export function unitStarted(parentId: string, unitId: string, nodeId: string) {
  return getStore().withLock(`djob:${parentId}`, () => retryOnConflict(() => unitStartedUnlocked(parentId, unitId, nodeId)));
}

async function unitStartedUnlocked(parentId: string, unitId: string, nodeId: string) {
  const store = getStore();
  const job = await store.getDistributedJob(parentId);
  if (!job) return;
  const u = job.units.find((x) => x.id === unitId && x.nodeId === nodeId);
  if (!u || u.status !== "assigned") return;
  const now = Date.now();
  u.status = "computing";
  u.startedAt = now;
  setStatus(job, "computing", now);
  await store.saveDistributedJob(job);
  eventBus.publish({ type: "work.started", at: now, jobId: job.id, unitId, nodeId, job: structuredClone(job) });
}

/**
 * Called by submitResult after the unit's own spot-check. Adds redundancy comparison when a
 * sibling replica has returned, records verification metadata, and advances the parent.
 */
export function unitResult(unitJob: StoredJob, node: StoredNode, result: WorkloadResult, spotOk: boolean, spotReason: string | undefined, checked: number, gpuMs: number) {
  // The lock serializes instances that acquire it; the conflict retry covers the ones that could not
  // wait. Each attempt re-reads the parent, so a verified unit is never written over a stale copy.
  return getStore().withLock(`djob:${unitJob.parentId}`, () => retryOnConflict(() => unitResultUnlocked(unitJob, node, result, spotOk, spotReason, checked, gpuMs)));
}

async function unitResultUnlocked(unitJob: StoredJob, node: StoredNode, result: WorkloadResult, spotOk: boolean, spotReason: string | undefined, checked: number, gpuMs: number) {
  const store = getStore();
  const job = await store.getDistributedJob(unitJob.parentId!);
  if (!job) return;
  const u = job.units.find((x) => x.id === unitJob.unitId);
  if (!u) return;
  // A previous attempt of this call already recorded the outcome and lost only a later save.
  if (u.status === "verified" || u.status === "mismatch") return settle(job);
  const now = Date.now();
  u.returnedAt = now;
  u.gpuMsReported = Math.max(0, Math.round(gpuMs) || 0);
  u.status = "returned";
  setStatus(job, "verifying", now);
  eventBus.publish({ type: "work.completed", at: now, jobId: job.id, unitId: u.id, nodeId: node.id, job: structuredClone(job) });

  let ok = spotOk;
  let reason = spotReason;
  let method: NonNullable<WorkUnit["verification"]>["method"] = "spot-check";
  let confidence = spotConfidence(checked);

  if (job.redundancy === 2 && ok) {
    // Compare against any sibling replica that has already passed its own spot-check.
    const sibling = job.units.find((x) => x.index === u.index && x.id !== u.id && x.status === "verified");
    if (sibling) {
      const sibJob = await store.getJob(sibling.id);
      const sibResult = sibJob?.lastResult;
      if (sibResult) {
        const cmp = compareRedundant([sibResult, result]);
        method = "redundant+spot-check";
        if (cmp.ok) confidence = 1 - (1 - confidence) * (1 - spotConfidence(checked));
        else {
          ok = false;
          reason = "replica-disagreement";
        }
      }
    }
  }

  u.verification = { method, confidence: Math.round(confidence * 1000) / 1000, latencyMs: Date.now() - now, checked, reason: ok ? undefined : reason };
  if (ok) {
    u.status = "verified";
    u.verifiedAt = Date.now();
    recomputeTotals(job);
    await store.saveDistributedJob(job);
    eventBus.publish({ type: "work.verified", at: Date.now(), jobId: job.id, unitId: u.id, nodeId: node.id, units: u.computeUnits, job: structuredClone(job) });
  } else {
    u.status = "mismatch";
    recomputeTotals(job);
    await store.saveDistributedJob(job);
    eventBus.publish({ type: "work.failed", at: Date.now(), jobId: job.id, unitId: u.id, nodeId: node.id, reason: reason ?? "mismatch", job: structuredClone(job) });
    await reassign(job, u, node.id, `verification failed: ${reason}`);
  }
  await settle(job);
}

/** A unit's node vanished or its deadline passed. */
export function unitLost(unitJob: StoredJob, reason: "lost" | "deadline") {
  return getStore().withLock(`djob:${unitJob.parentId}`, () => retryOnConflict(() => unitLostUnlocked(unitJob, reason)));
}

async function unitLostUnlocked(unitJob: StoredJob, reason: "lost" | "deadline") {
  const store = getStore();
  const job = await store.getDistributedJob(unitJob.parentId!);
  if (!job) return;
  const u = job.units.find((x) => x.id === unitJob.unitId);
  if (!u || u.status === "verified" || u.status === "mismatch" || u.status === "lost" || u.status === "failed") return;
  u.status = "lost";
  recomputeTotals(job);
  await store.saveDistributedJob(job);
  eventBus.publish({ type: "work.failed", at: Date.now(), jobId: job.id, unitId: u.id, nodeId: u.nodeId, reason, job: structuredClone(job) });
  await reassign(job, u, u.nodeId, reason === "lost" ? "node lost" : "deadline exceeded");
  await settle(job);
}

/** Re-issue a slot on a different live node, with a fresh seed so a cached answer can't be replayed. */
async function reassign(job: DistributedJob, failed: WorkUnit, fromNodeId: string, why: string) {
  const store = getStore();
  if (slotDone(job, failed.index, failed.replica) || slotOpen(job, failed.index, failed.replica)) return;
  if (failed.attempt >= cfg.maxAttemptsPerUnit) {
    failed.status = "failed";
    return;
  }
  const candidates = (await store.listNodes()).filter((n) => live(n) && n.id !== fromNodeId);
  const pool = candidates.length ? candidates : (await store.listNodes()).filter(live);
  if (pool.length === 0) return; // settle() will fail the job if nothing can take it
  // Least-loaded live node.
  const load = new Map<string, number>();
  for (const u of job.units) if (u.status === "assigned" || u.status === "computing") load.set(u.nodeId, (load.get(u.nodeId) ?? 0) + 1);
  pool.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || b.computeScore - a.computeScore);
  const target = pool[0];
  const now = Date.now();
  const original = await store.getJob(failed.id);
  const seedB = original?.spec.kernel === "matmul_u32" ? original.spec.seedB : secureU32();
  const spec = unitSpec(job.workload.unitDims, seedB);
  const unit: WorkUnit = {
    id: `${failed.id}#${failed.attempt + 1}`,
    index: failed.index,
    label: failed.label,
    nodeId: target.id,
    status: "assigned",
    attempt: failed.attempt + 1,
    replica: failed.replica,
    replacedUnitId: failed.id,
    assignedAt: now,
    computeUnits: workloadUnits(spec),
  };
  job.units.push(unit);
  await store.saveJob(makeUnitJob(job, unit, spec, now));
  if (target.status !== "computing") await store.saveNode({ ...target, status: "computing" });
  recomputeTotals(job);
  job.lifecycle.push({ stage: job.status, at: now, detail: `unit ${failed.label} → node ${target.id} (${why})` });
  await store.saveDistributedJob(job);
  eventBus.publish({ type: "work.reassigned", at: now, jobId: job.id, unitId: unit.id, fromNodeId, toNodeId: target.id, job: structuredClone(job) });
}

/** Complete when every slot verified; fail when a slot is dead and nothing is pending. */
async function settle(job: DistributedJob) {
  if (job.status === "completed" || job.status === "failed") return;
  const slots: [number, number][] = [];
  for (let i = 0; i < job.totals.workUnits; i++) for (let r = 0; r < job.redundancy; r++) slots.push([i, r]);
  const allDone = slots.every(([i, r]) => slotDone(job, i, r));
  const anyOpen = slots.some(([i, r]) => slotOpen(job, i, r));
  const now = Date.now();
  if (allDone) {
    job.completedAt = now;
    job.totals.latencyMs = now - job.createdAt;
    recomputeTotals(job);
    setStatus(job, "completed", now, `${job.totals.verified} verified · ${job.totals.computeUnits} compute units`);
    await getStore().saveDistributedJob(job);
    eventBus.publish({ type: "djob.completed", at: now, job: structuredClone(job) });
    await issueReceipt(job);
  } else if (!anyOpen) {
    job.completedAt = now;
    job.totals.latencyMs = now - job.createdAt;
    job.failReason = "unrecoverable work unit";
    setStatus(job, "failed", now, job.failReason);
    await getStore().saveDistributedJob(job);
    eventBus.publish({ type: "djob.failed", at: now, job: structuredClone(job) });
    await issueReceipt(job);
  } else {
    await getStore().saveDistributedJob(job);
  }
}

/**
 * Fold in unit outcomes the parent missed. submitResult closes the unit's own job before it updates
 * the parent; if that second step fails (lock queue past its timeout and the conflict retries used
 * up under 64 simultaneous returns, a transient database error, the function's time limit) the
 * unit is done but the parent still shows it assigned, and the node cannot resubmit a closed job.
 * Any pass over the parent repairs this from the unit jobs, which are the record of what happened.
 * Returns the parent as it stands afterwards.
 */
export async function reconcile(parentId: string): Promise<DistributedJob | null> {
  const store = getStore();
  const job = await store.getDistributedJob(parentId);
  if (!job || job.status === "completed" || job.status === "failed") return job;
  let repaired = 0;
  for (const u of job.units) {
    if (u.status !== "assigned" && u.status !== "computing" && u.status !== "returned") continue;
    const unitJob = await store.getJob(u.id);
    if (!unitJob || unitJob.status === "assigned") continue;
    const node = (await store.getNode(u.nodeId)) ?? ({ id: u.nodeId } as StoredNode);
    if (unitJob.status === "completed" && unitJob.lastResult) {
      // Same verification outcome the node received; redundancy comparison re-runs against siblings.
      await unitResult(unitJob, node, unitJob.lastResult, unitJob.verified === true, unitJob.verified ? undefined : unitJob.failReason, unitJob.sampleIndices.length, unitJob.latencyMs ?? 0);
    } else if (unitJob.status === "failed" && unitJob.lastResult && unitJob.failReason !== "node lost" && unitJob.failReason !== "deadline") {
      await unitResult(unitJob, node, unitJob.lastResult, false, unitJob.failReason, 0, unitJob.latencyMs ?? 0);
    } else {
      await unitLost(unitJob, unitJob.failReason === "deadline" ? "deadline" : "lost");
    }
    repaired++;
  }
  if (repaired) console.warn(`[distributed] job ${parentId}: reconciled ${repaired} unit(s) from their unit jobs`);
  return repaired ? ((await store.getDistributedJob(parentId)) ?? job) : job;
}

/** All pending units of a node that just went offline: reassign each. */
export async function nodeLost(nodeId: string) {
  const store = getStore();
  for (const unitJob of await store.pendingUnitsFor(nodeId)) {
    await store.saveJob({ ...unitJob, status: "failed", failReason: "node lost", lifecycle: [...unitJob.lifecycle, { stage: "failed", at: Date.now(), detail: "node lost" }] });
    await unitLost(unitJob, "lost");
  }
}

/**
 * Self-healing pass run from the node sweep: no distributed job may hold an open unit on a node
 * that is no longer live, and none may outlive its TTL in a non-terminal state.
 */
export async function reapStale(knownLive?: Set<string>) {
  const store = getStore();
  const now = Date.now();
  const liveIds = knownLive ?? new Set((await store.listNodes()).filter(live).map((n) => n.id));
  for (const listed of await store.listDistributedJobs(25)) {
    if (listed.status === "completed" || listed.status === "failed") continue;
    // Units whose own job already finished but never reached the parent (see reconcile).
    const job = (await reconcile(listed.id)) ?? listed;
    if (job.status === "completed" || job.status === "failed") continue;
    const orphans = job.units.filter((u) => (u.status === "assigned" || u.status === "computing") && !liveIds.has(u.nodeId));
    for (const u of orphans) {
      const unitJob = await store.getJob(u.id);
      if (unitJob && unitJob.status === "assigned") {
        await store.saveJob({ ...unitJob, status: "failed", failReason: "node lost", lifecycle: [...unitJob.lifecycle, { stage: "failed", at: now, detail: "node lost" }] });
        await unitLost(unitJob, "lost");
      }
    }
    await store.withLock(`djob:${job.id}`, async () => {
      const current = (await store.getDistributedJob(job.id))!;
      if (current.status !== "completed" && current.status !== "failed" && now - current.createdAt > jobTtlMs(current)) {
        current.completedAt = now;
        current.totals.latencyMs = now - current.createdAt;
        current.failReason = "timed out";
        setStatus(current, "failed", now, current.failReason);
        await store.saveDistributedJob(current);
        eventBus.publish({ type: "djob.failed", at: now, job: structuredClone(current) });
        await issueReceipt(current);
      }
    });
  }
}

export async function listJobs(limit = 10) {
  return getStore().listDistributedJobs(limit);
}

export async function getJob(id: string) {
  return getStore().getDistributedJob(id);
}

/** Real-only network summary for /demo. Nothing simulated contributes. */
export async function realSummary(knownNodes?: StoredNode[]) {
  const store = getStore();
  const nodes = (knownNodes ?? (await store.listNodes())).filter(live);
  const jobs = await store.listDistributedJobs(100);
  const done = jobs.filter((j) => j.status === "completed");
  const unitsAll = jobs.flatMap((j) => j.units).filter((u) => u.status === "verified" || u.status === "mismatch" || u.status === "failed");
  const verifiedUnits = unitsAll.filter((u) => u.status === "verified").length;
  return {
    source: "real" as const,
    realNodes: nodes.length,
    capacityScore: nodes.reduce((s, n) => s + n.computeScore, 0),
    verifiedComputeUnits: nodes.reduce((s, n) => s + n.verifiedComputeUnits, 0),
    jobsCompleted: done.length,
    workUnitsVerified: verifiedUnits,
    successRate: unitsAll.length ? verifiedUnits / unitsAll.length : null,
  };
}
