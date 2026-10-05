import type { CurrentEpochProgress, Provenance, RewardAllocation, RewardEpoch } from "@/domain/types";
import { networkConfig } from "@/lib/config";
import { defaultRewardConfig } from "@/rewards/config";
import { computeEpoch, type ContributorInput } from "@/rewards/formula";
import { contributorPoolToday } from "@/rewards/simulate";
import { demoSolPriceUsd } from "@/services/mock/mockData";
import { NodeError } from "./nodes";
import { getStore, type StoredNode } from "./store";
import { getHoldings } from "./wallet";

export const LAMPORTS_PER_SOL = 1_000_000_000;
const DAY_MS = 24 * 60 * 60_000;

export function epochLengthMs(): number {
  const m = Number(process.env.BRAIN_EPOCH_MINUTES);
  return m > 0 ? Math.round(m * 60_000) : networkConfig.rewards.epochMs;
}

export function epochAt(t: number) {
  const len = epochLengthMs();
  const startsAt = Math.floor(t / len) * len;
  return { id: `E-${new Date(startsAt).toISOString().slice(0, 16)}Z`, startsAt, endsAt: startsAt + len };
}

/** SIMULATED pool for one epoch: the demo USD contributor pool at the demo SOL rate. */
export function demoPoolLamports(lengthMs = epochLengthMs()): number {
  return Math.floor((contributorPoolToday() / demoSolPriceUsd) * LAMPORTS_PER_SOL * (lengthMs / DAY_MS));
}

/** Operator-committed pool per epoch, if configured. Only operator-funded pools can settle as live. */
export function configuredPoolLamports(): number | null {
  const sol = Number(process.env.BRAIN_EPOCH_POOL_SOL);
  return sol > 0 ? Math.floor(sol * LAMPORTS_PER_SOL) : null;
}

interface WalletWork {
  wallet: string;
  nodes: StoredNode[];
  verifiedCompute: number;
  jobsAssigned: number;
  jobsCompleted: number;
  checked: number;
  passed: number;
  buckets: Set<number>;
  banned: boolean;
}

/**
 * Per-wallet work in [from, to), measured only from server-verified job records.
 * Nodes without a signature-verified wallet do not accrue rewards.
 */
export async function measureWork(from: number, to: number) {
  const store = getStore();
  const jobs = await store.listJobsBetween(from, to);
  const nodes = new Map<string, StoredNode | null>();
  const byWallet = new Map<string, WalletWork>();
  const bucketMs = networkConfig.rewards.availabilityBucketMs;
  let networkVerifiedCompute = 0;

  for (const j of jobs) {
    if (j.verified) networkVerifiedCompute += j.computeUnits;
    if (j.status === "assigned") continue; // still in flight
    if (!nodes.has(j.assignedTo)) nodes.set(j.assignedTo, await store.getNode(j.assignedTo));
    const node = nodes.get(j.assignedTo);
    if (!node?.walletVerified || !node.walletAddress) continue;
    let w = byWallet.get(node.walletAddress);
    if (!w) {
      w = { wallet: node.walletAddress, nodes: [], verifiedCompute: 0, jobsAssigned: 0, jobsCompleted: 0, checked: 0, passed: 0, buckets: new Set(), banned: false };
      byWallet.set(node.walletAddress, w);
    }
    if (!w.nodes.includes(node)) w.nodes.push(node);
    if (node.status === "banned") w.banned = true;
    w.jobsAssigned++;
    w.checked++;
    w.buckets.add(Math.floor(j.submittedAt / bucketMs));
    if (j.verified) {
      w.jobsCompleted++;
      w.passed++;
      w.verifiedCompute += j.computeUnits;
    }
  }
  const totalBuckets = Math.max(1, Math.ceil((to - from) / bucketMs));
  return { wallets: [...byWallet.values()], networkVerifiedCompute, totalBuckets };
}

function toInput(w: WalletWork, tokenAmount: number, totalBuckets: number): ContributorInput {
  const reliability = w.nodes.reduce((s, n) => s + n.reputation, 0) / Math.max(1, w.nodes.length);
  return {
    id: w.wallet,
    verifiedCompute: w.verifiedCompute,
    tokenAmount,
    reliability,
    jobsAssigned: w.jobsAssigned,
    jobsCompleted: w.jobsCompleted,
    availability: Math.min(1, w.buckets.size / totalBuckets),
    verificationPassRate: w.checked > 0 ? w.passed / w.checked : 0,
    banned: w.banned,
  };
}

export interface SettleOptions {
  epochStart: number;
  /** Operator-declared pool. Omit to use BRAIN_EPOCH_POOL_SOL, or the simulated pool if that is unset too. */
  poolLamports?: number;
  now?: number;
}

/** Settles one closed epoch. Idempotent: an epoch is written exactly once. */
export async function settleEpoch(opts: SettleOptions): Promise<{ epoch: RewardEpoch; created: boolean }> {
  const store = getStore();
  const now = opts.now ?? Date.now();
  const e = epochAt(opts.epochStart);
  if (e.startsAt !== opts.epochStart) throw new NodeError("not_an_epoch_boundary");
  if (e.endsAt > now) throw new NodeError("epoch_open", 409);
  const existing = await store.getEpoch(e.id);
  if (existing) return { epoch: existing, created: false };

  const operatorPool = opts.poolLamports ?? configuredPoolLamports();
  const pool = Math.floor(operatorPool ?? demoPoolLamports(e.endsAt - e.startsAt));
  if (!(pool >= 0)) throw new NodeError("invalid_pool");

  const { wallets, totalBuckets } = await measureWork(e.startsAt, e.endsAt);
  const holdings = await Promise.all(wallets.map((w) => getHoldings(w.wallet)));
  const holdingsOnChain = Boolean(process.env.SOLANA_RPC_URL && process.env.BRAIN_TOKEN_MINT) && holdings.every((h) => h.provenance === "live");
  const provenance: Provenance = operatorPool != null && holdingsOnChain ? "live" : "simulated";

  const inputs = wallets.map((w, i) => toInput(w, holdings[i].amount, totalBuckets));
  const result = computeEpoch(inputs, pool, defaultRewardConfig);
  const allocations: RewardAllocation[] = [];
  result.rewards.forEach((r, i) => {
    const lamports = Math.floor(r.payout);
    if (!r.eligible || lamports <= 0) return;
    allocations.push({
      epochId: e.id,
      wallet: r.id,
      lamports,
      verifiedCompute: inputs[i].verifiedCompute,
      jobsAssigned: inputs[i].jobsAssigned,
      jobsCompleted: inputs[i].jobsCompleted,
      availability: inputs[i].availability,
      multiplier: r.multiplier,
      quality: r.quality,
      computeShare: r.computeShare,
      capped: r.capped,
      provenance,
    });
  });

  const epoch: RewardEpoch = {
    id: e.id,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    poolLamports: pool,
    distributedLamports: allocations.reduce((s, a) => s + a.lamports, 0),
    participants: allocations.length,
    totalVerifiedCompute: inputs.reduce((s, x) => s + x.verifiedCompute, 0),
    settledAt: now,
    provenance,
  };
  const created = await store.saveSettlement(epoch, allocations);
  return { epoch: created ? epoch : ((await store.getEpoch(e.id)) ?? epoch), created };
}

/**
 * What a wallet has accrued so far in the open epoch, against the reference pool pro-rated
 * to elapsed time. Uses holdings snapshotted at wallet link time. ESTIMATE, never claimable.
 */
export async function currentProgress(wallet: string, now = Date.now()): Promise<CurrentEpochProgress> {
  const e = epochAt(now);
  const { wallets, networkVerifiedCompute } = await measureWork(e.startsAt, now);
  const elapsedBuckets = Math.max(1, Math.ceil((now - e.startsAt) / networkConfig.rewards.availabilityBucketMs));
  const inputs = wallets.map((w) => toInput(w, Math.max(...w.nodes.map((n) => n.tokenAmount)), elapsedBuckets));
  const lastLive = (await getStore().listEpochs(30)).find((x) => x.provenance === "live");
  const refPool = lastLive?.poolLamports ?? configuredPoolLamports() ?? demoPoolLamports(e.endsAt - e.startsAt);
  const result = computeEpoch(inputs, refPool * ((now - e.startsAt) / (e.endsAt - e.startsAt)), defaultRewardConfig);
  const i = inputs.findIndex((x) => x.id === wallet);
  const r = i >= 0 ? result.rewards[i] : null;
  return {
    epochId: e.id,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    verifiedCompute: i >= 0 ? inputs[i].verifiedCompute : 0,
    networkVerifiedCompute,
    jobsCompleted: i >= 0 ? inputs[i].jobsCompleted : 0,
    availability: i >= 0 ? inputs[i].availability : 0,
    multiplier: r?.multiplier ?? 0,
    projectedLamports: Math.floor(r?.payout ?? 0),
    provenance: "estimated",
  };
}
