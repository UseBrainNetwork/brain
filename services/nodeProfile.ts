import type { NodeReputation } from "@/domain/economy";
import { networkConfig } from "@/lib/config";
import { getStore, type StoredNode } from "./store";

/**
 * Public reputation profile for one anonymous node, computed from server records only:
 * the node row (server-maintained counters) and the unit jobs the server issued to it.
 * Nothing here is client-reported. No IP, wallet or personal data is included.
 */

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function uptimeOf(n: StoredNode, now = Date.now()): number {
  const live = n.status === "idle" || n.status === "computing";
  const end = live ? now : n.lastHeartbeatAt;
  const span = Math.max(networkConfig.nodes.heartbeatMs, end - n.joinedAt);
  const expected = span / networkConfig.nodes.heartbeatMs;
  return Math.min(1, n.heartbeats / expected);
}

export async function nodeProfile(nodeId: string, now = Date.now()): Promise<NodeReputation | null> {
  const store = getStore();
  const n = await store.getNode(nodeId);
  if (!n) return null;
  const jobs = await store.listJobsForNode(nodeId, 500);
  const latencies: number[] = [];
  let assigned = 0;
  let lostOrDeadline = 0;
  for (const j of jobs) {
    if (!j.parentId) continue;
    assigned++;
    if (j.status === "completed" && j.verified && j.latencyMs != null) latencies.push(j.latencyMs);
    if (j.failReason === "node lost" || j.failReason === "deadline") lostOrDeadline++;
  }
  return profileOf(n, now, { medianLatencyMs: median(latencies), reassignmentRate: assigned > 0 ? lostOrDeadline / assigned : null });
}

/**
 * Reputation from the node record alone: no per-node job scan. The two fields that need the scan
 * (median latency, reassignment rate) are reported as unknown rather than guessed. Used where many
 * profiles are listed at once and the store is the bottleneck.
 */
export function profileOf(n: StoredNode, now = Date.now(), scan: { medianLatencyMs: number | null; reassignmentRate: number | null } = { medianLatencyMs: null, reassignmentRate: null }): NodeReputation {
  const checked = n.verifiedJobs + n.failedJobs;
  return {
    nodeId: n.id,
    firstSeenAt: n.firstSeenAt ?? n.joinedAt,
    lastSeenAt: n.lastHeartbeatAt,
    online: n.status === "idle" || n.status === "computing",
    deviceClass: n.deviceClass,
    computeScore: n.computeScore,
    jobsCompleted: n.verifiedJobs,
    jobsFailed: n.failedJobs,
    jobsVerified: n.verifiedJobs,
    verificationRate: checked > 0 ? n.verifiedJobs / checked : null,
    uptime: uptimeOf(n, now),
    medianLatencyMs: scan.medianLatencyMs,
    computeUnits: n.verifiedComputeUnits,
    reassignmentRate: scan.reassignmentRate,
    reputationScore: n.reputation,
    source: "REAL",
  };
}

/** Top nodes by verified compute. `light` skips the per-node job scan (one store read instead of 1 + 2n). */
export async function listProfiles(limit = 50, opts: { light?: boolean; nodes?: StoredNode[] } = {}): Promise<NodeReputation[]> {
  const nodes = (opts.nodes ?? (await getStore().listNodes())).slice().sort((a, b) => b.verifiedComputeUnits - a.verifiedComputeUnits).slice(0, limit);
  if (opts.light) {
    const now = Date.now();
    return nodes.map((n) => profileOf(n, now));
  }
  const out: NodeReputation[] = [];
  for (const n of nodes) {
    const p = await nodeProfile(n.id);
    if (p) out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------ contributor economics */

import type { AccountingEvent, RewardEpochV2 } from "@/domain/economy";
import { allocate, defaultEngineConfig } from "@/rewards/engine";
import { epochAt } from "./settlement";

export interface NodeEconomics {
  nodeId: string;
  verifiedCompute: number;
  /** Units that belonged to a priced job (a customer accrued a cost). */
  customerJobs: number;
  /** Units credited without a customer price — carried by the network / creator rewards. */
  subsidizedJobs: number;
  customerFundedUsd: number | null;
  creatorRewardLamports: number | null;
  tokenShare: number | null;
  /** Share of the current open epoch's pool this node would receive if it closed now. */
  rewardWeight: number | null;
  epochId: string;
  source: "REAL";
}

/** The open epoch's dry-run allocation is network-wide; one computation per instance per 15 s serves every node poll. */
const DRY_TTL_MS = 15_000;
const dryCache = globalThis as typeof globalThis & { __brainDry?: { at: number; epochId: string; value: Promise<ReturnType<typeof allocate>> } };
async function openEpochDryRun(now: number) {
  const e = epochAt(now);
  const hit = dryCache.__brainDry;
  if (hit && hit.epochId === e.id && now - hit.at < DRY_TTL_MS) return hit.value;
  const value = (async () => {
    const { measureNodes } = await import("./epochs");
    const { inputs } = await measureNodes(e.startsAt, now);
    return allocate(inputs, 1, 1, defaultEngineConfig);
  })();
  dryCache.__brainDry = { at: now, epochId: e.id, value };
  value.catch(() => {
    if (dryCache.__brainDry?.value === value) dryCache.__brainDry = undefined;
  });
  return value;
}

export async function nodeEconomics(nodeId: string, now = Date.now()): Promise<NodeEconomics | null> {
  const store = getStore();
  const n = await store.getNode(nodeId);
  if (!n) return null;
  const jobs = (await store.listJobsForNode(nodeId, 200)).filter((j) => j.parentId && j.verified);
  let customerJobs = 0;
  let subsidizedJobs = 0;
  const seen = new Map<string, boolean>();
  for (const j of jobs) {
    const pid = j.parentId!;
    if (!seen.has(pid)) {
      const r = await store.getDoc<{ customerCost: unknown }>("receipt", `r-${pid}`);
      seen.set(pid, Boolean(r?.customerCost));
    }
    if (seen.get(pid)) customerJobs++;
    else subsidizedJobs++;
  }
  const [earnedAll, epochs, dry] = await Promise.all([
    store.listDocs<AccountingEvent>("accounting", { key: "REAL", limit: 5_000 }),
    store.listDocs<RewardEpochV2>("epochv2", { key: "REAL", limit: 200 }),
    openEpochDryRun(now),
  ]);
  const earned = earnedAll.filter((e) => e.type === "COMPUTE_PROVIDER_EARNED" && e.relatedNodeId === nodeId);
  const allocs = epochs.flatMap((e) => e.allocations.filter((a) => a.nodeId === nodeId));
  const e = epochAt(now);
  const row = dry.rows.find((r) => r.nodeId === nodeId);
  return {
    nodeId,
    verifiedCompute: n.verifiedComputeUnits,
    customerJobs,
    subsidizedJobs,
    customerFundedUsd: earned.length ? earned.reduce((s, x) => s + x.amount, 0) : null,
    creatorRewardLamports: allocs.length ? allocs.reduce((s, a) => s + a.lamports, 0) : null,
    tokenShare: n.walletVerified ? n.tokenAmount / defaultEngineConfig.circulatingSupply : null,
    rewardWeight: row && row.eligible ? row.share : null,
    epochId: e.id,
    source: "REAL",
  };
}
