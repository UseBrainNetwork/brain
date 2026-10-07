import type { CurrentEpochProgress, Provenance, RewardAllocation, RewardEpoch } from "@/domain/types";
import { networkConfig } from "@/lib/config";
import { defaultRevenueSplit, defaultRewardConfig } from "@/rewards/config";
import { computeEpoch, type ContributorInput } from "@/rewards/formula";
import { contributorPoolToday } from "@/rewards/simulate";
import { demoSolPriceUsd } from "@/services/mock/mockData";
import { NodeError } from "./nodes";
import { notifySettled } from "./notify";
import { listNativeNodes, type NativeNode } from "./coordinator/registry";
import { getStore, type StoredNode } from "./store";
import { allocateFromTreasury, syncedTreasury } from "./treasury";
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

/**
 * Pool funded by real creator fees: the contributors' share (published split) of the REAL
 * treasury balance that has been received and not yet allocated. Zero until an operator records
 * a creator-fee receipt by transaction signature. Never includes anything simulated.
 */
export async function treasuryPoolLamports(lengthMs = epochLengthMs()): Promise<number> {
  const t = await syncedTreasury();
  const contributors = t.balance * defaultRevenueSplit.creatorRewards.contributors;
  // Pace the pool: an epoch gets the slice of the contributors' share proportional to its length over
  // BRAIN_POOL_PACE_DAYS (default 1 day). Daily epochs take the whole share; hourly epochs take 1/24.
  const pace = Math.max(lengthMs, paceDays() * DAY_MS);
  return Math.max(0, Math.floor(contributors * (lengthMs / pace) * LAMPORTS_PER_SOL));
}

function paceDays(): number {
  const d = Number(process.env.BRAIN_POOL_PACE_DAYS);
  return d > 0 ? d : 1;
}

/**
 * Settles every closed, unsettled epoch in the recent window (bounded). Idempotent and cheap when
 * nothing is due, so callers can run it opportunistically (dashboard reads) as well as from cron.
 * Throttled per process so a busy dashboard does not hammer the database.
 */
export async function settleDueEpochs(now = Date.now(), maxEpochs = 6): Promise<RewardEpoch[]> {
  const g = globalThis as typeof globalThis & { __brainSettleAt?: number; __brainSettling?: boolean };
  if (g.__brainSettling || now - (g.__brainSettleAt ?? 0) < 30_000) return [];
  g.__brainSettleAt = now;
  const store = getStore();
  const len = epochLengthMs();
  const last = epochAt(now - len);
  // Cheapest possible exit for the common case: the last closed epoch is already settled.
  if (await store.getEpoch(last.id)) return [];
  g.__brainSettling = true;
  try {
    return await settleDueUnlocked(store, now, len, last.startsAt, maxEpochs);
  } finally {
    g.__brainSettling = false;
  }
}

async function settleDueUnlocked(store: ReturnType<typeof getStore>, now: number, len: number, lastStart: number, maxEpochs: number): Promise<RewardEpoch[]> {
  const settled: RewardEpoch[] = [];
  // Never auto-write simulated epochs: only settle when there is a real pool to distribute.
  if ((await treasuryPoolLamports(len)) <= 0 && configuredPoolLamports() == null) return [];
  const last = { startsAt: lastStart };
  // Only epochs after the first verified job need settling; before that there is nothing to pay.
  for (let i = 0, start = last.startsAt; i < maxEpochs && start >= 0; i++, start -= len) {
    if (await store.getEpoch(epochAt(start).id)) break; // everything older is settled already
    const work = await store.aggregateWork(start, start + len, networkConfig.rewards.availabilityBucketMs);
    if (work.length === 0) continue;
    try {
      const r = await settleEpoch({ epochStart: start, now });
      if (r.created) settled.push(r.epoch);
    } catch (e) {
      console.error("[settlement] auto-settle failed", epochAt(start).id, e instanceof Error ? e.message : e);
      break;
    }
  }
  return settled;
}

/**
 * What settlement needs to know about a node, whichever registry it lives in. Browser nodes come
 * from brain_nodes; native GPU nodes from the coordinator registry. Both populations settle through
 * the same formula with the same inputs.
 */
export interface Earner {
  id: string;
  deviceClass: string;
  /** 0..1 */
  reputation: number;
  status: string;
  walletAddress?: string;
  /** Proven by a wallet signature. Unverified wallets never accrue. */
  walletVerified: boolean;
  tokenAmount: number;
}

const fromStored = (n: StoredNode): Earner => ({ id: n.id, deviceClass: n.deviceClass, reputation: n.reputation, status: n.status, walletAddress: n.walletAddress, walletVerified: n.walletVerified, tokenAmount: n.tokenAmount });

const fromNative = (n: NativeNode): Earner => ({
  id: n.nodeId,
  deviceClass: n.benchmark.computeClass ?? "UNMEASURED",
  reputation: n.reputation / 100,
  status: n.state === "OFFLINE" ? "offline" : "idle",
  walletAddress: n.wallet?.address,
  walletVerified: Boolean(n.wallet?.verified && n.wallet.address),
  tokenAmount: 0,
});

/** Resolves every node id that did work, across both registries, in two batched reads. */
export async function resolveEarners(ids: string[]): Promise<Map<string, Earner>> {
  const out = new Map<string, Earner>();
  if (ids.length === 0) return out;
  const stored = await getStore().getNodes(ids);
  for (const [id, n] of stored) out.set(id, fromStored(n));
  const missing = ids.filter((id) => !out.has(id));
  if (missing.length) {
    const native = new Map((await listNativeNodes()).map((n) => [n.nodeId, n]));
    for (const id of missing) {
      const n = native.get(id);
      if (n) out.set(id, fromNative(n));
    }
  }
  return out;
}

interface WalletWork {
  wallet: string;
  nodes: Earner[];
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
/**
 * Failures the node is not shown to be responsible for: units that expired or were reassigned, and
 * network-inference work the server could not check (no replica) or could not attribute (two nodes
 * disagreed). They lower the completion factor but never the pass rate.
 */
export const isLostUnit = (failReason: string | null | undefined) => failReason === "deadline" || failReason === "node lost" || failReason === "no-replica" || failReason === "replica-dispute";

export async function measureWork(from: number, to: number) {
  const store = getStore();
  const bucketMs = networkConfig.rewards.availabilityBucketMs;
  // Aggregated in the store: one row per (node, status, verified). Never loads job rows, so an epoch
  // with a hundred thousand jobs costs one indexed range scan.
  const rows = await store.aggregateWork(from, to, bucketMs);
  // One batched read per registry for every node that worked, not one round-trip per node.
  const nodes = await resolveEarners([...new Set(rows.filter((r) => r.status !== "assigned").map((r) => r.nodeId))]);
  const byWallet = new Map<string, WalletWork>();
  let networkVerifiedCompute = 0;

  for (const r of rows) {
    if (r.verified) networkVerifiedCompute += r.computeUnits;
    if (r.status === "assigned") continue; // still in flight
    const node = nodes.get(r.nodeId);
    if (!node?.walletVerified || !node.walletAddress) continue;
    let w = byWallet.get(node.walletAddress);
    if (!w) {
      w = { wallet: node.walletAddress, nodes: [], verifiedCompute: 0, jobsAssigned: 0, jobsCompleted: 0, checked: 0, passed: 0, buckets: new Set(), banned: false };
      byWallet.set(node.walletAddress, w);
    }
    if (!w.nodes.includes(node)) w.nodes.push(node);
    if (node.status === "banned") w.banned = true;
    w.jobsAssigned += r.jobs;
    // The verification pass rate judges results the node actually returned. A unit that expired
    // ("deadline") or was reassigned ("node lost") is a lost unit, not a failed check: it lowers the
    // completion factor but must not disqualify the wallet. When the server itself was too slow to
    // record results, every honest node's deadline count spiked and the old rule zeroed them all.
    if (r.verified || !isLostUnit(r.failReason)) w.checked += r.jobs;
    for (const b of r.buckets) w.buckets.add(b);
    if (r.verified) {
      w.jobsCompleted += r.jobs;
      w.passed += r.jobs;
      w.verifiedCompute += r.computeUnits;
    }
  }
  const totalBuckets = Math.max(1, Math.ceil((to - from) / bucketMs));
  return { wallets: [...byWallet.values()], networkVerifiedCompute, totalBuckets };
}

export interface EpochWorkRow {
  nodeId: string;
  deviceClass: string;
  reputation: number;
  status: string;
  wallet: string | null;
  /** True only when the wallet was proven by signature; unlinked nodes never accrue. */
  walletVerified: boolean;
  jobs: number;
  verifiedJobs: number;
  verifiedCompute: number;
  availability: number;
}

export interface EpochWorkReport {
  epochId: string;
  startsAt: number;
  endsAt: number;
  /** Open epoch → projection against the paced pool; settled → the recorded epoch. */
  state: "open" | "closed-unsettled" | "settled";
  poolLamports: number;
  networkVerifiedCompute: number;
  nodes: EpochWorkRow[];
  /** Per wallet: what the engine would (open) or did (settled) allocate. */
  wallets: { wallet: string; nodes: string[]; verifiedCompute: number; share: number; lamports: number; eligible: boolean; multiplier: number; capped: boolean }[];
  unlinked: { nodes: number; verifiedCompute: number };
}

/**
 * Operator view of one epoch: every node that did work, whether it is linked, and how the pool
 * splits. Reads the same aggregates settlement uses, so it cannot disagree with what gets paid.
 */
export async function epochWorkReport(epochStart: number, now = Date.now()): Promise<EpochWorkReport> {
  const store = getStore();
  const len = epochLengthMs();
  const e = epochAt(epochStart);
  const to = Math.min(now, e.endsAt);
  const bucketMs = networkConfig.rewards.availabilityBucketMs;
  const rows = await store.aggregateWork(e.startsAt, to, bucketMs);
  const done = rows.filter((r) => r.status !== "assigned");
  const nodes = await resolveEarners([...new Set(done.map((r) => r.nodeId))]);
  const totalBuckets = Math.max(1, Math.ceil((to - e.startsAt) / bucketMs));

  const byNode = new Map<string, EpochWorkRow & { buckets: Set<number> }>();
  let networkVerifiedCompute = 0;
  for (const r of done) {
    const n = nodes.get(r.nodeId);
    let row = byNode.get(r.nodeId);
    if (!row) {
      row = {
        nodeId: r.nodeId,
        deviceClass: n?.deviceClass ?? "UNKNOWN",
        reputation: n?.reputation ?? 0,
        status: n?.status ?? "unknown",
        wallet: n?.walletAddress ?? null,
        walletVerified: Boolean(n?.walletVerified && n?.walletAddress),
        jobs: 0,
        verifiedJobs: 0,
        verifiedCompute: 0,
        availability: 0,
        buckets: new Set(),
      };
      byNode.set(r.nodeId, row);
    }
    row.jobs += r.jobs;
    for (const b of r.buckets) row.buckets.add(b);
    if (r.verified) {
      row.verifiedJobs += r.jobs;
      row.verifiedCompute += r.computeUnits;
      networkVerifiedCompute += r.computeUnits;
    }
  }
  const nodeRows: EpochWorkRow[] = [...byNode.values()]
    .map(({ buckets, ...r }) => ({ ...r, availability: Math.min(1, buckets.size / totalBuckets) }))
    .sort((a, b) => b.verifiedCompute - a.verifiedCompute);
  const unlinkedRows = nodeRows.filter((r) => !r.walletVerified);

  const settled = e.endsAt <= now ? await store.getEpoch(e.id) : null;
  if (settled) {
    const allocs = await store.allocationsForEpoch(e.id);
    return {
      epochId: e.id,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      state: "settled",
      poolLamports: settled.poolLamports,
      networkVerifiedCompute,
      nodes: nodeRows,
      wallets: allocs
        .map((a) => ({
          wallet: a.wallet,
          nodes: nodeRows.filter((r) => r.wallet === a.wallet && r.walletVerified).map((r) => r.nodeId),
          verifiedCompute: a.verifiedCompute,
          share: a.computeShare,
          lamports: a.lamports,
          eligible: true,
          multiplier: a.multiplier,
          capped: a.capped,
        }))
        .sort((a, b) => b.lamports - a.lamports),
      unlinked: { nodes: unlinkedRows.length, verifiedCompute: unlinkedRows.reduce((s, r) => s + r.verifiedCompute, 0) },
    };
  }

  // Open or closed-but-unsettled: dry-run the engine exactly as settlement would, against the paced pool.
  const { wallets } = await measureWork(e.startsAt, to);
  const fullPool = (await treasuryPoolLamports(len)) || configuredPoolLamports() || 0;
  const pool = Math.floor(fullPool * ((to - e.startsAt) / len));
  const inputs = wallets.map((w) => toInput(w, Math.max(0, ...w.nodes.map((n) => n.tokenAmount)), totalBuckets));
  const result = computeEpoch(inputs, pool, defaultRewardConfig);
  return {
    epochId: e.id,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    state: e.endsAt <= now ? "closed-unsettled" : "open",
    poolLamports: pool,
    networkVerifiedCompute,
    nodes: nodeRows,
    wallets: result.rewards
      .map((r, i) => ({
        wallet: r.id,
        nodes: wallets[i].nodes.map((n) => n.id),
        verifiedCompute: inputs[i].verifiedCompute,
        share: r.computeShare,
        lamports: Math.floor(r.payout),
        eligible: r.eligible,
        multiplier: r.multiplier,
        capped: r.capped,
      }))
      .sort((a, b) => b.lamports - a.lamports),
    unlinked: { nodes: unlinkedRows.length, verifiedCompute: unlinkedRows.reduce((s, r) => s + r.verifiedCompute, 0) },
  };
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

  // Pool precedence: explicit > creator-fee treasury (real) + configured subsidy > simulated demo.
  const treasuryPool = opts.poolLamports == null ? await treasuryPoolLamports(e.endsAt - e.startsAt) : 0;
  const configured = configuredPoolLamports();
  const operatorPool = opts.poolLamports ?? (treasuryPool > 0 || configured != null ? treasuryPool + (configured ?? 0) : null);
  const pool = Math.floor(operatorPool ?? demoPoolLamports(e.endsAt - e.startsAt));
  if (!(pool >= 0)) throw new NodeError("invalid_pool");

  const { wallets, totalBuckets } = await measureWork(e.startsAt, e.endsAt);
  const holdings = await Promise.all(wallets.map((w) => getHoldings(w.wallet)));
  const chainConfigured = Boolean(process.env.SOLANA_RPC_URL && process.env.BRAIN_TOKEN_MINT);
  const holdingsLive = holdings.every((h) => h.provenance === "live");
  // Real money with a transient RPC failure must not be written as a SIMULATED epoch (epochs are written
  // once, and simulated allocations are never claimable). Refuse now; the caller retries later.
  if (operatorPool != null && chainConfigured && !holdingsLive) throw new NodeError("holdings_unavailable", 503);
  const provenance: Provenance = operatorPool != null && chainConfigured && holdingsLive ? "live" : "simulated";

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
  // Move the treasury's part of what was actually distributed from "balance" to "allocated".
  if (created && provenance === "live" && treasuryPool > 0 && epoch.distributedLamports > 0) {
    const fromTreasury = Math.min(treasuryPool, epoch.distributedLamports) / LAMPORTS_PER_SOL;
    await allocateFromTreasury(fromTreasury, e.id);
  }
  // Payout emails for wallets that asked for them. Never affects the settlement itself.
  if (created && provenance === "live" && allocations.length > 0) {
    try {
      const r = await notifySettled(epoch, allocations);
      if (r.error) console.error("[settlement] notify", e.id, r.error);
    } catch (err) {
      console.error("[settlement] notify failed", e.id, err instanceof Error ? err.message : err);
    }
  }
  return { epoch: created ? epoch : ((await store.getEpoch(e.id)) ?? epoch), created };
}

/**
 * What a wallet has accrued so far in the open epoch, against the reference pool pro-rated
 * to elapsed time. Uses holdings snapshotted at wallet link time. ESTIMATE, never claimable.
 */
/** Network-wide open-epoch picture; identical for every wallet, so shared per instance for a few seconds. */
/** Matches the store's one-minute aggregate cache; a shorter TTL only re-reads the same cached rows. */
const PROGRESS_TTL_MS = 60_000;
let progressCache: { at: number; value: Promise<{ e: ReturnType<typeof epochAt>; now: number; inputs: ReturnType<typeof toInput>[]; networkVerifiedCompute: number; result: ReturnType<typeof computeEpoch> }> } | null = null;

async function networkProgress(now: number) {
  const e = epochAt(now);
  const { wallets, networkVerifiedCompute } = await measureWork(e.startsAt, now);
  const elapsedBuckets = Math.max(1, Math.ceil((now - e.startsAt) / networkConfig.rewards.availabilityBucketMs));
  const inputs = wallets.map((w) => toInput(w, Math.max(...w.nodes.map((n) => n.tokenAmount)), elapsedBuckets));
  const lastLive = (await getStore().listEpochs(30)).find((x) => x.provenance === "live");
  const refPool = lastLive?.poolLamports ?? configuredPoolLamports() ?? demoPoolLamports(e.endsAt - e.startsAt);
  const result = computeEpoch(inputs, refPool * ((now - e.startsAt) / (e.endsAt - e.startsAt)), defaultRewardConfig);
  return { e, now, inputs, networkVerifiedCompute, result };
}

export async function currentProgress(wallet: string, now = Date.now()): Promise<CurrentEpochProgress> {
  if (!progressCache || now - progressCache.at > PROGRESS_TTL_MS || epochAt(now).id !== epochAt(progressCache.at).id) {
    const value = networkProgress(now);
    progressCache = { at: now, value };
    value.catch(() => {
      if (progressCache?.value === value) progressCache = null;
    });
  }
  const { e, inputs, networkVerifiedCompute, result } = await progressCache.value;
  const i = inputs.findIndex((x) => x.id === wallet);
  const r = i >= 0 ? result.rewards[i] : null;
  return {
    epochId: e.id,
    eligible: r ? r.eligible : false,
    ineligibleReason: r?.reason ?? (i < 0 ? "no-verified-compute" : undefined),
    verificationPassRate: i >= 0 ? inputs[i].verificationPassRate : null,
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
