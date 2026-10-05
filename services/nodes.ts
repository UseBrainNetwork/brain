import type { ComputeJob, ComputeNode, DeviceClass, DistributedJob, JobLifecycleEvent, JobStatus, WorkloadKind } from "@/domain/types";
import { networkConfig } from "@/lib/config";
import { referenceResult, workloadOps, workloadUnits, type WorkloadResult, type WorkloadSpec } from "@/network/workloads";
import { estimateReward } from "@/rewards/simulate";
import { nodeLost, unitLost, unitResult, unitStarted, reapStale } from "./distributed";
import { eventBus } from "./eventBus";
import { updateReputation } from "./reputation";
import { publicNodeId, sampleIndices, secureU32, sha256, token } from "./security";
import { getStore, type StoredJob, type StoredNode } from "./store";
import { plausibleDuration, verifyCanary, verifySpotCheck } from "./verification";

const DEVICE_CLASSES: DeviceClass[] = ["M4_MAX", "RTX_4090", "RTX_4080", "M3_MAX", "RX_7900", "OTHER_WEBGPU"];

export class NodeError extends Error {
  constructor(public code: string, public status = 400) {
    super(code);
  }
}

/** Strip every secret before a node leaves the server. */
export function publicNode(n: StoredNode): ComputeNode {
  return {
    id: n.id,
    deviceClass: n.deviceClass,
    status: n.status,
    computeScore: n.computeScore,
    maxBufferBytes: n.maxBufferBytes,
    advertisedMemoryGb: n.advertisedMemoryGb,
    joinedAt: n.joinedAt,
    lastHeartbeatAt: n.lastHeartbeatAt,
    verifiedJobs: n.verifiedJobs,
    failedJobs: n.failedJobs,
    verifiedComputeUnits: n.verifiedComputeUnits,
    reputation: n.reputation,
    provenance: "live",
  };
}

export function publicJob(j: StoredJob): ComputeJob {
  return {
    id: j.id,
    model: j.model,
    kind: j.kind,
    status: j.status,
    nodeIds: j.nodeIds,
    workUnits: j.workUnits,
    computeUnits: j.computeUnits,
    latencyMs: j.latencyMs,
    submittedAt: j.submittedAt,
    lifecycle: j.lifecycle,
    provenance: "live",
  };
}

/* ---------------------------------------------------------------- benchmark */

export async function issueChallenge(ipHash: string, hintRoundsPerSec?: number) {
  const b = networkConfig.benchmark;
  const hint = Number.isFinite(hintRoundsPerSec) && hintRoundsPerSec! > 0 ? hintRoundsPerSec! : 2e9;
  const rounds = Math.round(Math.min(b.maxRounds, Math.max(b.minRounds, (hint * b.targetMs) / 1000 / b.threads)));
  const spec = { kernel: "mix_u32" as const, seed: secureU32(), rounds, threads: b.threads, blockSize: b.blockSize };
  const id = token(16);
  await getStore().saveChallenge({ id, spec, issuedAt: Date.now(), ipHash, used: false });
  return { challengeId: id, spec };
}

export interface RegisterInput {
  challengeId: string;
  result: WorkloadResult;
  clientGpuMs: number;
  device: { deviceClass?: string; name?: string; maxBufferBytes?: number };
  /**
   * Persistent anonymous identity, generated and kept by the browser. `proof` is a random
   * secret; the server stores only its hash. A browser can reclaim its id across sessions,
   * nobody else can. Carries no IP, wallet or personal data.
   */
  identity?: { id?: string; proof?: string };
}

const ID_RE = /^[0-9A-F]{4,6}$/;
const PROOF_RE = /^[0-9a-f]{32,128}$/;

/** Resolve the public id for a registering browser. See RegisterInput.identity. */
async function resolveNodeId(input: RegisterInput): Promise<{ id: string; identityHash?: string; carry?: Pick<StoredNode, "verifiedJobs" | "failedJobs" | "verifiedComputeUnits" | "reputation" | "firstSeenAt"> }> {
  const store = getStore();
  const wanted = String(input.identity?.id ?? "").toUpperCase();
  const proof = String(input.identity?.proof ?? "");
  if (ID_RE.test(wanted) && PROOF_RE.test(proof)) {
    const identityHash = sha256(`identity:${proof}`);
    const existing = await store.getNode(wanted);
    if (!existing) return { id: wanted, identityHash };
    const liveNow = (existing.status === "idle" || existing.status === "computing") && Date.now() - existing.lastHeartbeatAt < networkConfig.nodes.offlineAfterMs;
    if (existing.identityHash === identityHash && !liveNow && existing.status !== "banned") {
      return { id: wanted, identityHash, carry: { verifiedJobs: existing.verifiedJobs, failedJobs: existing.failedJobs, verifiedComputeUnits: existing.verifiedComputeUnits, reputation: existing.reputation, firstSeenAt: existing.firstSeenAt ?? existing.joinedAt } };
    }
  }
  let id = publicNodeId();
  while (await store.getNode(id)) id = publicNodeId();
  // Collision or foreign id: hand out a fresh one, but still bind it to this browser's proof.
  return { id, identityHash: PROOF_RE.test(proof) ? sha256(`identity:${proof}`) : undefined };
}

export async function registerNode(ipHash: string, input: RegisterInput) {
  const store = getStore();
  const ch = await store.getChallenge(String(input.challengeId ?? ""));
  if (!ch || ch.used) throw new NodeError("invalid_challenge");
  if (ch.ipHash !== ipHash) throw new NodeError("challenge_origin_mismatch", 403);
  const serverElapsedMs = Date.now() - ch.issuedAt;
  if (serverElapsedMs > networkConfig.benchmark.challengeTtlMs) throw new NodeError("challenge_expired");
  await store.saveChallenge({ ...ch, used: true });

  if (!plausibleDuration(ch.spec, serverElapsedMs)) throw new NodeError("implausible_timing");
  const blocks = Math.ceil(ch.spec.threads / ch.spec.blockSize);
  const outcome = verifySpotCheck(ch.spec, input.result, sampleIndices(blocks, networkConfig.benchmark.sampledBlocks));
  if (!outcome.ok) throw new NodeError(`benchmark_failed:${outcome.reason}`, 422);

  // Score from the SERVER clock around a challenge it issued. Client timing is informational.
  const opsPerSec = workloadOps(ch.spec) / (serverElapsedMs / 1000);
  const computeScore = Math.max(1, Math.round(opsPerSec / networkConfig.scoreScale));

  const deviceClass = DEVICE_CLASSES.includes(input.device?.deviceClass as DeviceClass)
    ? (input.device.deviceClass as DeviceClass)
    : "OTHER_WEBGPU";
  const maxBuffer = Number(input.device?.maxBufferBytes) || undefined;
  const sessionToken = token(32);
  const { id, identityHash, carry } = await resolveNodeId(input);

  const now = Date.now();
  const node: StoredNode = {
    id,
    deviceClass,
    // Standby until the user explicitly joins; not counted or broadcast yet.
    status: "benchmarking",
    computeScore,
    maxBufferBytes: maxBuffer,
    // Pool memory we're willing to schedule against: a fraction of the adapter's max buffer.
    advertisedMemoryGb: maxBuffer ? Math.round((maxBuffer / 2 ** 30) * 0.5 * 10) / 10 : 0.5,
    joinedAt: now,
    lastHeartbeatAt: now,
    verifiedJobs: 0,
    failedJobs: 0,
    verifiedComputeUnits: 0,
    reputation: networkConfig.reputation.initial,
    provenance: "live",
    sessionHash: sha256(sessionToken),
    ipHash,
    walletVerified: false,
    tokenAmount: 0,
    heartbeats: 0,
    clientReportedDevice: String(input.device?.name ?? "").slice(0, 120),
    identityHash,
    firstSeenAt: now,
    ...carry,
  };
  await store.saveNode(node);

  return {
    sessionToken,
    node: publicNode(node),
    benchmark: {
      challengeId: ch.id,
      kernel: ch.spec.kernel,
      dims: { m: ch.spec.threads, n: 1, k: ch.spec.rounds },
      clientElapsedMs: Number(input.clientGpuMs) || 0,
      serverElapsedMs,
      opsPerSec,
      computeScore,
      verified: true,
    },
  };
}

/* ---------------------------------------------------------------- sessions */

export async function authNode(sessionToken: string | null): Promise<StoredNode> {
  if (!sessionToken) throw new NodeError("unauthorized", 401);
  const node = await getStore().getNodeBySession(sha256(sessionToken));
  if (!node) throw new NodeError("unauthorized", 401);
  if (node.status === "banned") throw new NodeError("banned", 403);
  return node;
}

const isLive = (n: StoredNode) => n.status === "idle" || n.status === "computing";

const sweepState = globalThis as typeof globalThis & { __brainSweepAt?: number; __brainReapAt?: number };

/**
 * Marks silent nodes offline and expires overdue jobs. Throttled per instance (one sweep per 15 s,
 * the heavier distributed-job reap once per 45 s) because every instance of the function runs its
 * own sweep and the store is the shared bottleneck. The sweep never blocks the caller for long:
 * it is awaited only for its first phase and bounded by the store timeouts.
 */
export async function sweepOffline() {
  const now = Date.now();
  if (now - (sweepState.__brainSweepAt ?? 0) < 15_000) return;
  sweepState.__brainSweepAt = now;
  const store = getStore();
  const nodes = await store.listNodes();
  const liveIds = new Set<string>();
  for (const n of nodes) {
    if (isLive(n) && now - n.lastHeartbeatAt > networkConfig.nodes.offlineAfterMs) {
      await store.saveNode({ ...n, status: "offline" });
      eventBus.publish({ type: "node.left", at: now, nodeId: n.id, memoryGb: n.advertisedMemoryGb, reason: "lost" });
      await nodeLost(n.id);
    } else if (isLive(n)) liveIds.add(n.id);
  }
  for (const j of await store.listOpenJobs(200, now - 10 * 60_000)) {
    if (now > j.deadline) {
      await store.saveJob({ ...j, status: "failed", failReason: "deadline", lifecycle: [...j.lifecycle, { stage: "failed", at: now, detail: "deadline exceeded" }] });
      if (j.parentId) await unitLost(j, "deadline");
    }
  }
  if (now - (sweepState.__brainReapAt ?? 0) >= 45_000) {
    sweepState.__brainReapAt = now;
    await reapStale(liveIds);
  }
}

/** Standby → live. This is the moment the node becomes part of the network. */
export async function joinNetwork(node: StoredNode) {
  if (isLive(node)) return publicNode(node);
  const now = Date.now();
  const next: StoredNode = { ...node, status: "idle", joinedAt: now, lastHeartbeatAt: now };
  await getStore().saveNode(next);
  eventBus.publish({ type: "node.joined", at: now, node: publicNode(next) });
  return publicNode(next);
}

export async function heartbeat(node: StoredNode) {
  const now = Date.now();
  const revived = node.status === "offline";
  const next: StoredNode = { ...node, lastHeartbeatAt: now, heartbeats: node.heartbeats + 1, status: revived ? "idle" : node.status };
  await getStore().saveNode(next);
  if (revived) eventBus.publish({ type: "node.joined", at: now, node: publicNode(next) });
  else if (isLive(next)) eventBus.publish({ type: "node.heartbeat", at: now, nodeId: next.id });
  await sweepOffline();
  return publicNode(next);
}

export async function leave(node: StoredNode) {
  // Session ends: a fresh benchmark is required to rejoin.
  await getStore().saveNode({ ...node, status: "offline", sessionHash: `revoked:${node.sessionHash}` });
  if (isLive(node)) {
    eventBus.publish({ type: "node.left", at: Date.now(), nodeId: node.id, memoryGb: node.advertisedMemoryGb, reason: "left" });
    await nodeLost(node.id);
  }
}

const liveCache = globalThis as typeof globalThis & { __brainLive?: { at: number; value: Promise<ComputeNode[]> } };
/** Public live-node list is read by almost every endpoint; one store read serves all callers on an instance for 2 s. */
const LIVE_TTL_MS = 2_000;

export async function liveNodes(): Promise<ComputeNode[]> {
  const now = Date.now();
  const hit = liveCache.__brainLive;
  if (hit && now - hit.at < LIVE_TTL_MS) return hit.value;
  const value = (async () => {
    await sweepOffline();
    const t = Date.now();
    // Filter by heartbeat age as well as status, so a throttled sweep never shows a silent node as online.
    return (await getStore().listNodes())
      .filter((n) => (n.status === "idle" || n.status === "computing") && t - n.lastHeartbeatAt <= networkConfig.nodes.offlineAfterMs)
      .map(publicNode);
  })();
  liveCache.__brainLive = { at: now, value };
  value.catch(() => {
    if (liveCache.__brainLive?.value === value) liveCache.__brainLive = undefined;
  });
  return value;
}

/* ---------------------------------------------------------------- dispatch */

interface JobTemplate {
  kind: WorkloadKind;
  model: string;
  spec: () => WorkloadSpec;
  canary?: boolean;
}

const templates: { weight: number; t: JobTemplate }[] = [
  {
    weight: 0.5,
    t: { kind: "tensor", model: "tensor/matmul-u32 256³", spec: () => ({ kernel: "matmul_u32", m: 256, n: 256, k: 256, seedA: secureU32(), seedB: secureU32() }) },
  },
  {
    weight: 0.3,
    t: { kind: "embedding", model: "embed/matvec-u32 512×2048×8", spec: () => ({ kernel: "matmul_u32", m: 512, n: 8, k: 2048, seedA: secureU32(), seedB: secureU32() }) },
  },
];
const canaryTemplate: JobTemplate = {
  kind: "verification",
  model: "verify/canary 96³",
  canary: true,
  spec: () => ({ kernel: "matmul_u32", m: 96, n: 96, k: 96, seedA: secureU32(), seedB: secureU32() }),
};

function pickTemplate(): JobTemplate {
  if (Math.random() < networkConfig.jobs.canaryRate) return canaryTemplate;
  const total = templates.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const x of templates) if ((r -= x.weight) <= 0) return x.t;
  return templates[0].t;
}

/**
 * Next job for a node. Pending distributed work units always come first. With
 * `distributedOnly`, a node waits for real work instead of taking filler verification jobs.
 */
/** Minimum gap between synthetic jobs per node. BRAIN_SYNTHETIC_JOB_MS, default 3000; 0 disables pacing. */
function syntheticPaceMs(): number {
  const v = process.env.BRAIN_SYNTHETIC_JOB_MS;
  if (v == null || v === "") return 3_000;
  const n = Number(v);
  return n >= 0 ? n : 3_000;
}

/** Milliseconds until this node's synthetic pacing window reopens (0 when it may take work now). */
export function syntheticWaitMs(node: StoredNode, now = Date.now()): number {
  const paceMs = syntheticPaceMs();
  if (paceMs <= 0 || !node.lastSyntheticAt) return 0;
  return Math.max(0, paceMs - (now - node.lastSyntheticAt));
}

export async function nextJob(node: StoredNode, opts: { distributedOnly?: boolean } = {}): Promise<StoredJob | null> {
  if (!isLive(node)) throw new NodeError("not_joined", 409);
  const store = getStore();
  const pending = await store.pendingJobFor(node.id);
  if (pending && pending.deadline > Date.now()) return pending;
  if (pending) await expireJob(pending, node);
  if (opts.distributedOnly) {
    if (node.status === "computing") await store.saveNode({ ...node, status: "idle" });
    return null;
  }
  // Pace self-generated (synthetic) work per node. Real distributed units are never paced; this only
  // keeps the embedded demo loop from writing a job every few hundred milliseconds per visitor.
  const paceMs = syntheticPaceMs();
  if (paceMs > 0 && node.lastSyntheticAt && Date.now() - node.lastSyntheticAt < paceMs) {
    if (node.status === "computing") await store.saveNode({ ...node, status: "idle" });
    return null;
  }

  const t = pickTemplate();
  const spec = t.spec();
  const now = Date.now();
  const id = String(await store.nextJobNumber());
  const rows = spec.kernel === "matmul_u32" ? spec.m : Math.ceil(spec.threads / spec.blockSize);
  const job: StoredJob = {
    id,
    model: t.model,
    kind: t.kind,
    status: "assigned",
    nodeIds: [node.id],
    workUnits: 1,
    computeUnits: workloadUnits(spec),
    submittedAt: now,
    lifecycle: [
      { stage: "submitted", at: now },
      { stage: "split", at: now, detail: "1 work unit" },
      { stage: "assigned", at: now, detail: `node ${node.id}` },
    ],
    provenance: "live",
    spec,
    assignedTo: node.id,
    issuedAt: now,
    deadline: now + networkConfig.jobs.deadlineMs,
    canary: Boolean(t.canary),
    sampleIndices: t.canary ? [] : sampleIndices(rows, networkConfig.jobs.sampledRows),
    expected: t.canary ? referenceResult(spec).hashes : undefined,
  };
  await store.saveJob(job);
  await store.saveNode({ ...node, status: "computing", lastSyntheticAt: now });
  return job;
}

async function expireJob(job: StoredJob, node: StoredNode) {
  await getStore().saveJob({ ...job, status: "failed", failReason: "deadline", lifecycle: [...job.lifecycle, { stage: "failed", at: Date.now(), detail: "deadline exceeded" }] });
  await getStore().saveNode(updateReputation(node, false));
  if (job.parentId) await unitLost(job, "deadline");
}

/** Node reports execution began. Display only: nothing here affects verification or credit. */
export async function startWork(node: StoredNode, jobId: string) {
  const job = await getStore().getJob(String(jobId));
  if (!job || job.assignedTo !== node.id || job.status !== "assigned") throw new NodeError("unknown_job", 404);
  if (job.parentId && job.unitId) await unitStarted(job.parentId, job.unitId, node.id);
  return { ok: true };
}

export async function submitResult(node: StoredNode, jobId: string, result: WorkloadResult, clientGpuMs: number) {
  const store = getStore();
  const job = await store.getJob(String(jobId));
  if (!job || job.assignedTo !== node.id) throw new NodeError("unknown_job", 404);
  if (job.status !== "assigned") throw new NodeError("job_closed", 409);
  const now = Date.now();
  if (now > job.deadline) {
    await expireJob(job, node);
    throw new NodeError("deadline_exceeded", 410);
  }

  const elapsed = now - job.issuedAt;
  const outcome = !plausibleDuration(job.spec, elapsed)
    ? ({ ok: false, method: "spot-check", reason: "implausible-timing" } as const)
    : job.canary
      ? verifyCanary(job.spec, result, job.expected!)
      : verifySpotCheck(job.spec, result, job.sampleIndices);

  let updated = updateReputation(node, outcome.ok);
  const stillBusy = Boolean(job.parentId) && (await store.pendingUnitsFor(node.id)).some((u) => u.id !== job.id);
  updated = {
    ...updated,
    status: updated.status === "banned" ? "banned" : stillBusy ? "computing" : "idle",
    verifiedComputeUnits: updated.verifiedComputeUnits + (outcome.ok ? job.computeUnits : 0),
  };
  await store.saveNode(updated);

  const closed: StoredJob = {
    ...job,
    status: outcome.ok ? "completed" : "failed",
    latencyMs: elapsed,
    verified: outcome.ok,
    failReason: outcome.ok ? undefined : outcome.reason,
    lifecycle: [
      ...job.lifecycle,
      { stage: "executing", at: now - Math.min(elapsed, Math.max(1, Math.round(Number(clientGpuMs) || 0))), detail: "client GPU (reported)" },
      { stage: "verifying", at: now, detail: outcome.method },
      ...(outcome.ok
        ? [
            { stage: "merged" as const, at: now },
            { stage: "completed" as const, at: now, detail: `+${job.computeUnits} units` },
          ]
        : [{ stage: "failed" as const, at: now, detail: outcome.reason }]),
    ],
    lastResult: job.parentId ? result : undefined,
  };
  await store.saveJob(closed);
  if (job.parentId) await unitResult(closed, updated, result, outcome.ok, outcome.ok ? undefined : outcome.reason, outcome.ok ? outcome.checked : 0, Number(clientGpuMs) || 0);

  const est = estimateReward({ computeScore: updated.computeScore, tokenAmount: updated.tokenAmount });
  const estRewardUsd = outcome.ok ? est.perUnitUsd * job.computeUnits : 0;

  eventBus.publish({ type: "job.completed", at: now, job: publicJob(closed) });
  if (outcome.ok) eventBus.publish({ type: "node.verified", at: now, nodeId: node.id, units: job.computeUnits, jobId: job.id });

  return {
    verified: outcome.ok,
    method: outcome.method,
    reason: outcome.ok ? undefined : outcome.reason,
    units: outcome.ok ? job.computeUnits : 0,
    latencyMs: elapsed,
    estRewardUsd,
    node: publicNode(updated),
    job: publicJob(closed),
  };
}

/** The job payload a client receives. Contains no verification secrets. */
export function jobPayload(j: StoredJob) {
  return { id: j.id, kind: j.kind, model: j.model, spec: j.spec, deadline: j.deadline, units: j.computeUnits, parentId: j.parentId, unitId: j.unitId };
}

export async function linkWallet(node: StoredNode, address: string, tokenAmount: number) {
  const next = { ...node, walletAddress: address, walletVerified: true, tokenAmount };
  await getStore().saveNode(next);
  return publicNode(next);
}

/** Explorer view of a distributed (parent) job, mapped onto the generic ComputeJob shape. */
export function publicDistributedJob(j: DistributedJob): ComputeJob {
  const map: Record<DistributedJob["status"], JobStatus> = { queued: "submitted", assigning: "split", distributed: "assigned", computing: "executing", verifying: "verifying", completed: "completed", failed: "failed" };
  const lifecycle: JobLifecycleEvent[] = j.lifecycle.map((l) => ({ stage: map[l.stage], at: l.at, detail: l.detail }));
  if (j.status === "completed" && !lifecycle.some((l) => l.stage === "merged")) lifecycle.splice(lifecycle.length - 1, 0, { stage: "merged", at: j.completedAt ?? Date.now(), detail: `${j.totals.verified}/${j.totals.workUnits} verified units merged` });
  return {
    id: j.id,
    model: "tensor/matmul-u32",
    kind: "tensor",
    status: map[j.status],
    nodeIds: j.nodeIds,
    workUnits: j.totals.workUnits,
    computeUnits: j.totals.computeUnits,
    latencyMs: j.totals.latencyMs,
    submittedAt: j.createdAt,
    lifecycle,
    provenance: "live",
  };
}
