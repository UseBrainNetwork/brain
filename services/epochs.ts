import type { RewardEpochV2, RewardEpochV2Allocation } from "@/domain/economy";
import { allocate, defaultEngineConfig, type EngineInput } from "@/rewards/engine";
import { NodeError } from "./nodes";
import { sha256 } from "./receipts";
import { LAMPORTS_PER_SOL, epochAt } from "./settlement";
import { getStore, type StoredNode } from "./store";
import { allocateFromTreasury, getTreasury } from "./treasury";

/**
 * Reward epochs (v2). Finalization reads verified work from server job records (never from
 * node counters or anything a client sent), runs the reward engine, and writes an immutable
 * result whose hash anyone can recompute from the public allocation list.
 *
 * Pool: SOL lamports. With `fromTreasury`, the pool is drawn from the real creator-reward
 * treasury balance; otherwise the operator passes an explicit pool.
 */

export interface FinalizeInput {
  epochStart: number;
  poolLamports?: number;
  fromTreasury?: boolean;
  now?: number;
}

/**
 * Per-node verified work in a window, from the store's SQL aggregate (grouped by node, status,
 * verified). This used to load every job record in the window as full JSON: tens of megabytes per
 * call once the fleet grew, and it ran once per node poll. Now it is a few hundred small rows.
 */
export async function measureNodes(from: number, to: number) {
  const store = getStore();
  const rows = await store.aggregateWork(from, to, 60_000);
  const perNode = new Map<string, { verified: number; ok: number; total: number }>();
  for (const a of rows) {
    if (a.status === "assigned") continue;
    const row = perNode.get(a.nodeId) ?? { verified: 0, ok: 0, total: 0 };
    row.total += a.jobs;
    if (a.verified) {
      row.ok += a.jobs;
      row.verified += a.computeUnits;
    }
    perNode.set(a.nodeId, row);
  }
  const inputs: EngineInput[] = [];
  const nodes = new Map<string, StoredNode>();
  const found = await store.getNodes([...perNode.keys()]);
  for (const [nodeId, r] of perNode) {
    const n = found.get(nodeId);
    if (!n) continue;
    nodes.set(nodeId, n);
    inputs.push({
      nodeId,
      accountId: n.walletVerified && n.walletAddress ? n.walletAddress : undefined,
      verifiedCompute: r.verified,
      tokenOwnership: n.walletVerified ? n.tokenAmount : 0,
      reputation: n.reputation,
      reliability: r.total ? r.ok / r.total : 0,
    });
  }
  return { inputs, nodes };
}

export async function finalizeEpoch(input: FinalizeInput): Promise<{ epoch: RewardEpochV2; created: boolean }> {
  const store = getStore();
  const now = input.now ?? Date.now();
  const e = epochAt(input.epochStart);
  if (e.startsAt !== input.epochStart) throw new NodeError("not_an_epoch_boundary");
  if (e.endsAt > now) throw new NodeError("epoch_open", 409);
  const id = `${e.id}-v2`;
  const existing = await store.getDoc<RewardEpochV2>("epochv2", id);
  if (existing) return { epoch: existing, created: false };

  let pool = input.poolLamports ?? 0;
  if (input.fromTreasury) pool = Math.floor((await getTreasury("REAL")).balance * LAMPORTS_PER_SOL);
  if (!(pool >= 0)) throw new NodeError("invalid_pool");

  const { inputs, nodes } = await measureNodes(e.startsAt, e.endsAt);
  const result = allocate(inputs, pool, 1, defaultEngineConfig);
  const allocations: RewardEpochV2Allocation[] = result.rows
    .filter((r) => r.eligible && r.reward > 0)
    .map((r) => {
      const n = nodes.get(r.nodeId)!;
      return {
        nodeId: r.nodeId,
        wallet: n.walletVerified && n.walletAddress ? n.walletAddress : null,
        verifiedCompute: inputs.find((i) => i.nodeId === r.nodeId)!.verifiedCompute,
        holdingMultiplier: r.holdingMultiplier,
        qualityMultiplier: r.qualityMultiplier,
        weight: r.weight,
        share: r.share,
        lamports: Math.floor(r.reward),
        capped: r.capped,
      };
    })
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const distributed = allocations.reduce((s, a) => s + a.lamports, 0);
  const epoch: RewardEpochV2 = {
    epochId: id,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    finalizedAt: now,
    poolLamports: pool,
    distributedLamports: distributed,
    participants: allocations.length,
    totalVerifiedCompute: inputs.reduce((s, i) => s + i.verifiedCompute, 0),
    resultHash: sha256(`brain-epoch-v2|${id}|${pool}|` + allocations.map((a) => `${a.nodeId}:${a.verifiedCompute}:${a.lamports}`).join("|")),
    config: { alpha: defaultEngineConfig.alpha, holdingCap: defaultEngineConfig.holdingCap, maxHoldingMultiplier: defaultEngineConfig.maxHoldingMultiplier, minReputation: defaultEngineConfig.minReputation, minReliability: defaultEngineConfig.minReliability, maxAccountShare: defaultEngineConfig.maxAccountShare },
    source: "REAL",
    allocations,
  };
  await store.putDoc("epochv2", id, epoch, { at: e.startsAt, key: "REAL" });
  if (input.fromTreasury && distributed > 0) await allocateFromTreasury(distributed / LAMPORTS_PER_SOL, id);
  return { epoch, created: true };
}

export async function getEpochV2(id: string) {
  return getStore().getDoc<RewardEpochV2>("epochv2", id);
}

export async function listEpochsV2(limit = 20) {
  return getStore().listDocs<RewardEpochV2>("epochv2", { limit, key: "REAL" });
}

/** Recompute the hash from the public allocation list. Anyone can do this; the page shows the check. */
export function verifyEpochHash(e: RewardEpochV2) {
  const h = sha256(`brain-epoch-v2|${e.epochId}|${e.poolLamports}|` + [...e.allocations].sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map((a) => `${a.nodeId}:${a.verifiedCompute}:${a.lamports}`).join("|"));
  return h === e.resultHash;
}
