import type { ComputeJob, ComputeNode, DistributedJob, RewardAllocation, RewardClaim, RewardEpoch } from "@/domain/types";
import type { WorkloadResult, WorkloadSpec } from "@/network/workloads";
import { PgStore } from "./pgStore";

/**
 * Server-maintained counters on a node row only ever go up. Several handlers read a node, do work,
 * then write the whole row back (heartbeat, result verification, job dispatch over every online
 * node), and under a slow database a writer holding a stale copy used to overwrite increments
 * another writer had just made: a contributor's "verified compute" would visibly fall. A save may
 * therefore never roll one of these counters backwards; the larger value is the newer one.
 * Reputation (an EWMA, not monotonic) follows whichever writer has seen more checked jobs.
 */
export const MONOTONIC_NODE_COUNTERS = ["verifiedComputeUnits", "verifiedJobs", "failedJobs", "heartbeats"] as const;

export function mergeNodeCounters(prev: StoredNode | null | undefined, next: StoredNode): StoredNode {
  if (!prev) return next;
  const out: StoredNode = { ...next };
  for (const k of MONOTONIC_NODE_COUNTERS) out[k] = Math.max(prev[k] ?? 0, next[k] ?? 0);
  const checked = (n: StoredNode) => (n.verifiedJobs ?? 0) + (n.failedJobs ?? 0);
  if (checked(prev) > checked(next)) out.reputation = prev.reputation;
  return out;
}

export interface StoredNode extends ComputeNode {
  sessionHash: string;
  ipHash: string;
  /** Wallet proven via signed message. Unverified wallets never influence real payouts. */
  walletAddress?: string;
  walletVerified: boolean;
  tokenAmount: number;
  banReason?: string;
  /** Heartbeats received vs expected — availability input to the reward formula. */
  heartbeats: number;
  clientReportedDevice: string;
  /** sha256 of the client's persistent identity secret. Lets the same browser reclaim its id. */
  identityHash?: string;
  /** First registration of this identity. Survives rejoin; `joinedAt` is per session. */
  firstSeenAt?: number;
  /** When this node was last issued a synthetic (self-generated) job. Used to pace the demo loop. */
  lastSyntheticAt?: number;
}

export interface WorkAggregate {
  nodeId: string;
  status: string;
  verified: boolean;
  /** Why a failed row failed: "deadline" / "node lost" are server- or network-side; anything else is a verification outcome. */
  failReason: string | null;
  jobs: number;
  computeUnits: number;
  buckets: number[];
}

/**
 * A unit of coordinator-measured work that is not a browser kernel job: today, one customer
 * inference request served by a native GPU node. Lives in the same table and aggregate as
 * `StoredJob` so settlement sees one population; the shape is the subset settlement reads.
 */
export interface WorkRecord {
  id: string;
  /** "native-inference": a customer job. "native-verify": a shadow re-run of one that agreed with it. */
  source: "native-inference" | "native-verify";
  assignedTo: string;
  status: "completed" | "failed";
  submittedAt: number;
  verified: boolean;
  failReason?: string;
  computeUnits: number;
  model: string;
  tokens: { prompt: number; completion: number };
}

export interface StoredJob extends ComputeJob {
  spec: WorkloadSpec;
  assignedTo: string;
  issuedAt: number;
  deadline: number;
  canary: boolean;
  /** SECRET. Rows/blocks the server will recompute. Never serialized to clients. */
  sampleIndices: number[];
  /** Canary only: full expected hashes. SECRET. */
  expected?: number[];
  verified?: boolean;
  failReason?: string;
  /** Set when this job is one work unit of a distributed job. */
  parentId?: string;
  unitId?: string;
  /** Distributed units only: kept so a sibling replica can be compared against it. */
  lastResult?: WorkloadResult;
}

export interface StoredChallenge {
  id: string;
  spec: Extract<WorkloadSpec, { kernel: "mix_u32" }>;
  issuedAt: number;
  ipHash: string;
  used: boolean;
}

/** Postgres-compatible persistence boundary. See db/schema.sql and services/pgStore.ts. */
export interface NetworkStore {
  saveNode(n: StoredNode): Promise<void>;
  getNode(id: string): Promise<StoredNode | null>;
  /** Batched lookup; one query regardless of count. Missing ids are simply absent. */
  getNodes(ids: string[]): Promise<Map<string, StoredNode>>;
  getNodeBySession(sessionHash: string): Promise<StoredNode | null>;
  listNodes(): Promise<StoredNode[]>;
  /** Distinct GPU identities that have ever registered. Cumulative; never pruned. */
  countNodesJoined(): Promise<number>;
  saveJob(j: StoredJob): Promise<void>;
  getJob(id: string): Promise<StoredJob | null>;
  listRecentJobs(limit: number): Promise<StoredJob[]>;
  pendingJobFor(nodeId: string): Promise<StoredJob | null>;
  nextJobNumber(): Promise<number>;
  saveChallenge(c: StoredChallenge): Promise<void>;
  getChallenge(id: string): Promise<StoredChallenge | null>;

  /** Jobs submitted in [from, to). Settlement reads verified work from here, never from node counters. */
  listJobsBetween(from: number, to: number): Promise<StoredJob[]>;
  /**
   * Per-node work in [from, to) aggregated in the store (never loads job rows). One row per
   * (node, status, verified) with counts, verified compute units and the distinct availability buckets.
   */
  aggregateWork(from: number, to: number, bucketMs: number): Promise<WorkAggregate[]>;
  /** Upserts a non-kernel work record into the settlement aggregate (see WorkRecord). */
  recordWork(w: WorkRecord): Promise<void>;
  getWork(id: string): Promise<WorkRecord | null>;
  /** Jobs still in flight (not completed/failed) submitted after `since`, newest first. */
  listOpenJobs(limit: number, since: number): Promise<StoredJob[]>;
  getEpoch(id: string): Promise<RewardEpoch | null>;
  /** Writes the epoch and its allocations atomically. Returns false if the epoch already exists. */
  saveSettlement(epoch: RewardEpoch, allocations: RewardAllocation[]): Promise<boolean>;
  listEpochs(limit: number): Promise<RewardEpoch[]>;
  allocationsForWallet(wallet: string): Promise<RewardAllocation[]>;
  allocationsForEpoch(epochId: string): Promise<RewardAllocation[]>;
  /** Inserts a pending claim. Returns false if the id was used or the wallet already has a pending claim. */
  insertClaim(c: RewardClaim): Promise<boolean>;
  updateClaim(c: RewardClaim): Promise<void>;
  claimsForWallet(wallet: string): Promise<RewardClaim[]>;
  /** Sum of non-failed claims created since `since`, across all wallets. */
  claimedSince(since: number): Promise<number>;
  /** Paid claims (sent or confirmed) across all wallets, newest first. For the public payouts page. */
  listPaidClaims(limit: number): Promise<RewardClaim[]>;
  /** Totals over paid claims. Zero/null when nothing has been paid; never estimated. */
  paidClaimTotals(): Promise<PaidClaimTotals>;

  saveDistributedJob(j: DistributedJob): Promise<void>;
  getDistributedJob(id: string): Promise<DistributedJob | null>;
  listDistributedJobs(limit: number): Promise<DistributedJob[]>;
  /** Pending unit jobs for a node (status assigned) that belong to a distributed job. */
  pendingUnitsFor(nodeId: string): Promise<StoredJob[]>;
  /** Most recent jobs (unit or filler) assigned to a node. Reputation is computed from these. */
  listJobsForNode(nodeId: string, limit: number): Promise<StoredJob[]>;

  /**
   * Generic indexed documents for the economic layer (receipts, accounting events, orders, route
   * decisions, customers, api keys, request records, treasury, v2 epochs). `key` is a secondary
   * index (e.g. customerId, keyHash, source); `at` orders listings newest-first.
   */
  putDoc<T>(kind: DocKind, id: string, doc: T, index: { at: number; key?: string }): Promise<void>;
  getDoc<T>(kind: DocKind, id: string): Promise<T | null>;
  listDocs<T>(kind: DocKind, q?: DocQuery): Promise<T[]>;
  findDocByKey<T>(kind: DocKind, key: string): Promise<T | null>;
  /**
   * Run `fn` while holding an exclusive lock on `key`. Read-modify-write sections on a distributed
   * job (several nodes report results at the same instant) must go through this, or updates are lost.
   */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export const isPaidClaim = (c: RewardClaim) => c.status === "sent" || c.status === "confirmed";
export interface PaidClaimTotals {
  lamports: number;
  count: number;
  wallets: number;
  firstAt: number | null;
  lastAt: number | null;
}

export type DocKind = "nnode" | "njob" | "receipt" | "accounting" | "order" | "decision" | "plan" | "customer" | "apikey" | "request" | "treasury" | "epochv2" | "metric" | "account" | "credit" | "session" | "interest" | "notify" | "meta" | "shard" | "hop" | "isession" | "payment";

export interface DocQuery {
  limit?: number;
  key?: string;
  from?: number;
  to?: number;
}

interface DocRow {
  id: string;
  key?: string;
  at: number;
  data: unknown;
}

/** In-process mutex: one promise chain per key. */
export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }
}

export class MemoryStore implements NetworkStore {
  private mutex = new KeyedMutex();
  withLock<T>(key: string, fn: () => Promise<T>) {
    return this.mutex.run(key, fn);
  }
  private nodes = new Map<string, StoredNode>();
  private jobs = new Map<string, StoredJob>();
  private work = new Map<string, WorkRecord>();
  private challenges = new Map<string, StoredChallenge>();
  private epochs = new Map<string, RewardEpoch>();
  private allocations: RewardAllocation[] = [];
  private claims = new Map<string, RewardClaim>();
  private djobs = new Map<string, DistributedJob>();
  // Real job ids start in their own range so they never collide with simulated ones.
  private jobSeq = 5_000_000;

  async saveNode(n: StoredNode) {
    this.nodes.set(n.id, mergeNodeCounters(this.nodes.get(n.id), n));
  }
  async getNode(id: string) {
    return this.nodes.get(id) ?? null;
  }
  async getNodes(ids: string[]) {
    const out = new Map<string, StoredNode>();
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (n) out.set(id, n);
    }
    return out;
  }
  async getNodeBySession(sessionHash: string) {
    for (const n of this.nodes.values()) if (n.sessionHash === sessionHash) return n;
    return null;
  }
  async listNodes() {
    return [...this.nodes.values()];
  }
  async countNodesJoined() {
    return new Set([...this.nodes.values()].map((n) => n.identityHash ?? n.id)).size;
  }
  async saveJob(j: StoredJob) {
    this.jobs.set(j.id, { ...j });
    if (this.jobs.size > 5000) {
      const oldest = this.jobs.keys().next().value;
      if (oldest) this.jobs.delete(oldest);
    }
  }
  async getJob(id: string) {
    return this.jobs.get(id) ?? null;
  }
  async listRecentJobs(limit: number) {
    return [...this.jobs.values()].sort((a, b) => b.submittedAt - a.submittedAt).slice(0, limit);
  }
  async pendingJobFor(nodeId: string) {
    for (const j of this.jobs.values()) {
      if (j.assignedTo === nodeId && j.status === "assigned") return j;
    }
    return null;
  }
  async nextJobNumber() {
    return ++this.jobSeq;
  }
  async saveChallenge(c: StoredChallenge) {
    this.challenges.set(c.id, { ...c });
    if (this.challenges.size > 2000) {
      const oldest = this.challenges.keys().next().value;
      if (oldest) this.challenges.delete(oldest);
    }
  }
  async getChallenge(id: string) {
    return this.challenges.get(id) ?? null;
  }
  async listJobsBetween(from: number, to: number) {
    return [...this.jobs.values()].filter((j) => j.submittedAt >= from && j.submittedAt < to);
  }
  async recordWork(w: WorkRecord) {
    this.work.set(w.id, w);
  }
  async getWork(id: string) {
    return this.work.get(id) ?? null;
  }
  async aggregateWork(from: number, to: number, bucketMs: number) {
    const m = new Map<string, WorkAggregate & { b: Set<number> }>();
    const work = [...this.work.values()].filter((w) => w.submittedAt >= from && w.submittedAt < to);
    for (const j of [...(await this.listJobsBetween(from, to)), ...work]) {
      const reason = j.failReason ?? null;
      const k = `${j.assignedTo}|${j.status}|${Boolean(j.verified)}|${reason ?? ""}`;
      let a = m.get(k);
      if (!a) m.set(k, (a = { nodeId: j.assignedTo, status: j.status, verified: Boolean(j.verified), failReason: reason, jobs: 0, computeUnits: 0, buckets: [], b: new Set() }));
      a.jobs++;
      a.computeUnits += j.computeUnits;
      a.b.add(Math.floor(j.submittedAt / bucketMs));
    }
    return [...m.values()].map(({ b, ...a }) => ({ ...a, buckets: [...b] }));
  }
  async listOpenJobs(limit: number, since: number) {
    return (await this.listRecentJobs(limit)).filter((j) => j.status !== "completed" && j.status !== "failed" && j.submittedAt > since);
  }
  async getEpoch(id: string) {
    return this.epochs.get(id) ?? null;
  }
  async saveSettlement(epoch: RewardEpoch, allocations: RewardAllocation[]) {
    if (this.epochs.has(epoch.id)) return false;
    this.epochs.set(epoch.id, { ...epoch });
    this.allocations.push(...allocations.map((a) => ({ ...a })));
    return true;
  }
  async listEpochs(limit: number) {
    return [...this.epochs.values()].sort((a, b) => b.startsAt - a.startsAt).slice(0, limit);
  }
  async allocationsForWallet(wallet: string) {
    return this.allocations.filter((a) => a.wallet === wallet);
  }
  async allocationsForEpoch(epochId: string) {
    return this.allocations.filter((a) => a.epochId === epochId);
  }
  async insertClaim(c: RewardClaim) {
    if (this.claims.has(c.id)) return false;
    for (const x of this.claims.values()) if (x.wallet === c.wallet && x.status === "pending") return false;
    this.claims.set(c.id, { ...c });
    return true;
  }
  async updateClaim(c: RewardClaim) {
    this.claims.set(c.id, { ...c });
  }
  async claimsForWallet(wallet: string) {
    return [...this.claims.values()].filter((c) => c.wallet === wallet).sort((a, b) => b.createdAt - a.createdAt);
  }
  async claimedSince(since: number) {
    let sum = 0;
    for (const c of this.claims.values()) if (c.status !== "failed" && c.createdAt >= since) sum += c.lamports;
    return sum;
  }
  async listPaidClaims(limit: number) {
    return [...this.claims.values()].filter(isPaidClaim).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  async paidClaimTotals() {
    const paid = [...this.claims.values()].filter(isPaidClaim);
    return {
      lamports: paid.reduce((s, c) => s + c.lamports, 0),
      count: paid.length,
      wallets: new Set(paid.map((c) => c.wallet)).size,
      firstAt: paid.length ? Math.min(...paid.map((c) => c.createdAt)) : null,
      lastAt: paid.length ? Math.max(...paid.map((c) => c.createdAt)) : null,
    };
  }
  async saveDistributedJob(j: DistributedJob) {
    this.djobs.set(j.id, structuredClone(j));
    if (this.djobs.size > 200) {
      const oldest = this.djobs.keys().next().value;
      if (oldest) this.djobs.delete(oldest);
    }
  }
  async getDistributedJob(id: string) {
    const j = this.djobs.get(id);
    return j ? structuredClone(j) : null;
  }
  async listDistributedJobs(limit: number) {
    return [...this.djobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((j) => structuredClone(j));
  }
  async pendingUnitsFor(nodeId: string) {
    return [...this.jobs.values()].filter((j) => j.assignedTo === nodeId && j.status === "assigned" && j.parentId);
  }
  async listJobsForNode(nodeId: string, limit: number) {
    return [...this.jobs.values()].filter((j) => j.assignedTo === nodeId).sort((a, b) => b.submittedAt - a.submittedAt).slice(0, limit);
  }

  private docs = new Map<DocKind, Map<string, DocRow>>();
  private coll(kind: DocKind) {
    let m = this.docs.get(kind);
    if (!m) this.docs.set(kind, (m = new Map()));
    return m;
  }
  async putDoc<T>(kind: DocKind, id: string, doc: T, index: { at: number; key?: string }) {
    const m = this.coll(kind);
    m.set(id, { id, key: index.key, at: index.at, data: structuredClone(doc) });
    if (m.size > 20_000) {
      const oldest = m.keys().next().value;
      if (oldest) m.delete(oldest);
    }
  }
  async getDoc<T>(kind: DocKind, id: string) {
    const r = this.coll(kind).get(id);
    return r ? (structuredClone(r.data) as T) : null;
  }
  async listDocs<T>(kind: DocKind, q: DocQuery = {}) {
    return [...this.coll(kind).values()]
      .filter((r) => (q.key == null || r.key === q.key) && (q.from == null || r.at >= q.from) && (q.to == null || r.at < q.to))
      .sort((a, b) => b.at - a.at)
      .slice(0, q.limit ?? 100)
      .map((r) => structuredClone(r.data) as T);
  }
  async findDocByKey<T>(kind: DocKind, key: string) {
    for (const r of this.coll(kind).values()) if (r.key === key) return structuredClone(r.data) as T;
    return null;
  }
}

const g = globalThis as typeof globalThis & { __brainStore?: NetworkStore };

/** Dev HMR keeps the globalThis singleton across module reloads; replace it if its shape is stale. */
const REQUIRED: (keyof NetworkStore)[] = ["listDistributedJobs", "pendingUnitsFor", "putDoc", "listJobsForNode", "countNodesJoined", "aggregateWork", "recordWork", "listOpenJobs", "getNodes", "allocationsForEpoch"];

export function getStore(): NetworkStore {
  if (g.__brainStore && REQUIRED.some((k) => typeof g.__brainStore?.[k] !== "function")) g.__brainStore = undefined;
  if (!g.__brainStore) {
    // DATABASE_URL, or the pooled URL Vercel's Postgres integrations (Supabase, Neon, Prisma) inject.
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;
    if (url) {
      g.__brainStore = new PgStore(url);
    } else {
      g.__brainStore = new MemoryStore();
    }
  }
  return g.__brainStore;
}
