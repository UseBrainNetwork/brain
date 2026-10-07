/**
 * Core domain model for the BRAIN network.
 *
 * Every value that flows through the UI is typed here. Data sources (mock or real)
 * must produce these shapes; components never know which one they are talking to.
 */

import type { AccountingEvent, ComputeOrder, ComputeReceipt } from "./economy";
import type { PublicInferenceJob } from "@/services/coordinator/jobs";
import type { PublicNativeNode } from "@/services/coordinator/registry";

export type DeviceClass =
  | "M4_MAX"
  | "RTX_4090"
  | "RTX_4080"
  | "M3_MAX"
  | "RX_7900"
  | "OTHER_WEBGPU";

/** Where a datum came from. Rendered as a badge wherever it matters. */
export type Provenance = "live" | "simulated" | "estimated";

export type NodeStatus = "benchmarking" | "idle" | "computing" | "offline" | "banned";

export interface ComputeNode {
  /** Anonymous 4-hex public id (display) — never derived from wallet or IP. */
  id: string;
  deviceClass: DeviceClass;
  status: NodeStatus;
  /** Server-verified compute score (not the client claim). */
  computeScore: number;
  /** Max storage buffer binding reported by the adapter, in bytes. Not VRAM. */
  maxBufferBytes?: number;
  /** Memory the node advertises to the pool, GB. For simulated nodes this is synthetic. */
  advertisedMemoryGb: number;
  joinedAt: number;
  lastHeartbeatAt: number;
  verifiedJobs: number;
  failedJobs: number;
  verifiedComputeUnits: number;
  reputation: number; // 0..1
  provenance: Provenance;
}

export type WorkloadKind = "inference" | "embedding" | "verification" | "tensor";

export type JobStatus =
  | "submitted"
  | "split"
  | "assigned"
  | "executing"
  | "verifying"
  | "merged"
  | "completed"
  | "failed";

export interface JobLifecycleEvent {
  stage: JobStatus;
  at: number;
  detail?: string;
}

export interface ComputeJob {
  id: string; // numeric string, e.g. "92818"
  model: string; // e.g. "brain/qwen" or "tensor/matmul-u32"
  kind: WorkloadKind;
  status: JobStatus;
  nodeIds: string[];
  workUnits: number;
  computeUnits: number;
  latencyMs?: number;
  submittedAt: number;
  lifecycle: JobLifecycleEvent[];
  provenance: Provenance;
}

export type PoolStatus = "online" | "beta" | "degraded" | "offline";

export interface ModelPool {
  id: string;
  label: string;
  model: string;
  nodes: number;
  status: PoolStatus;
  minMemoryGb: number;
  requestsPerSec: number;
}

export interface NetworkMetrics {
  gpusOnline: number;
  availableMemoryTb: number;
  inferencesToday: number;
  creatorRewardsTodayUsd: number;
  paidToProvidersTodayUsd: number;
  /** null until real pricing benchmarks exist. */
  avgCostPer1MTokensUsd: number | null;
  uptimePct: number;
  requestsPerSec: number;
  capacityScore: number;
  /** Nodes that are genuinely connected to this server right now. */
  liveNodes: number;
  provenance: Provenance;
}

export interface NodeBenchmark {
  /** Server-issued challenge id. */
  challengeId: string;
  kernel: string;
  dims: { m: number; n: number; k: number };
  /** Client-measured GPU time (informational, untrusted). */
  clientElapsedMs: number;
  /** Server-measured issue→verified wall time (trusted upper bound). */
  serverElapsedMs?: number;
  /** ops/sec derived from the trusted duration. */
  opsPerSec?: number;
  computeScore?: number;
  verified: boolean;
}

export interface TokenHolding {
  address: string;
  amount: number;
  supplyShare: number; // 0..1
  provenance: Provenance;
}

export interface CreatorRevenue {
  period: "today" | "7d" | "30d" | "all";
  creatorRewardsUsd: number;
  computePayoutsUsd: number;
  inferenceRevenueUsd: number;
  provenance: Provenance;
}

/* -------------------------------------------------------------------------- */
/* Reward ledger. Amounts are lamports (1 SOL = 1e9) as integers.              */
/* -------------------------------------------------------------------------- */

export interface RewardEpoch {
  id: string;
  startsAt: number;
  endsAt: number;
  poolLamports: number;
  distributedLamports: number;
  participants: number;
  totalVerifiedCompute: number;
  settledAt: number;
  /** "live" only when the pool was funded by the operator and holdings came from chain. Only live epochs are claimable. */
  provenance: Provenance;
}

export interface RewardAllocation {
  epochId: string;
  wallet: string;
  lamports: number;
  verifiedCompute: number;
  jobsAssigned: number;
  jobsCompleted: number;
  availability: number;
  multiplier: number;
  quality: number;
  computeShare: number;
  capped: boolean;
  provenance: Provenance;
}

export type ClaimStatus = "pending" | "sent" | "confirmed" | "failed";

export interface RewardClaim {
  /** The single-use claim nonce the wallet signed. */
  id: string;
  wallet: string;
  lamports: number;
  status: ClaimStatus;
  createdAt: number;
  updatedAt: number;
  txSignature?: string;
  error?: string;
}

export interface PayoutStatus {
  enabled: boolean;
  /** Why claiming is unavailable, when it is. */
  reason?: string;
  asset: "SOL";
  minLamports: number;
  maxLamports: number;
  cluster: string;
  /** Public address claims are paid from, when configured. The key never leaves the server. */
  wallet?: string;
  /** Epoch ms when claims open, if a scheduled opening is configured and still in the future. */
  opensAt?: number;
}

export interface CurrentEpochProgress {
  epochId: string;
  startsAt: number;
  endsAt: number;
  verifiedCompute: number;
  networkVerifiedCompute: number;
  jobsCompleted: number;
  availability: number;
  multiplier: number;
  /** Projection against the reference pool; never claimable until the epoch settles. */
  projectedLamports: number;
  /** Whether this wallet would be paid if the epoch closed now, and why not if not. */
  eligible: boolean;
  ineligibleReason?: string;
  /** verified ÷ (verified + failed verification) for results the node returned this epoch. null without data. */
  verificationPassRate: number | null;
  provenance: "estimated";
}

export interface RewardsSummary {
  wallet: string;
  epochs: (RewardEpoch & { allocation: RewardAllocation })[];
  claims: RewardClaim[];
  current: CurrentEpochProgress;
  earnedLamports: number;
  claimedLamports: number;
  /** Live, settled, not yet claimed. */
  claimableLamports: number;
  /** Simulated balance, shown for demo purposes and never claimable. */
  demoLamports: number;
  /** True when epochs are DEMO history because this wallet has no settled epochs. */
  demo: boolean;
  payouts: PayoutStatus;
}

export interface InferenceRequest {
  id: string;
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  maxTokens?: number;
  temperature?: number;
  createdAt: number;
}

/* -------------------------------------------------------------------------- */
/* Realtime events. Transport-agnostic: mock generator, SSE or WebSocket.       */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Distributed jobs: one request split into work units across REAL nodes.      */
/* -------------------------------------------------------------------------- */

/** Explicit source tag. "real" means produced by actual devices and verified by this server. */
export type DataSource = "real" | "simulated";

export type WorkUnitStatus = "assigned" | "computing" | "returned" | "verified" | "mismatch" | "lost" | "failed";

export interface WorkUnit {
  /** `${jobId}-${letter}` e.g. "5000012-C". Replicas share the letter with a suffix. */
  id: string;
  index: number;
  label: string;
  nodeId: string;
  status: WorkUnitStatus;
  attempt: number;
  /** Set when this unit replaced one that was lost or failed. */
  replacedUnitId?: string;
  replica: number;
  assignedAt: number;
  startedAt?: number;
  returnedAt?: number;
  verifiedAt?: number;
  computeUnits: number;
  gpuMsReported?: number;
  verification?: {
    method: "spot-check" | "redundant+spot-check" | "canary";
    /** Probability the check would have caught a node that skipped ≥25% of the rows. */
    confidence: number;
    latencyMs: number;
    checked: number;
    reason?: string;
  };
}

export type DistributedJobStatus = "queued" | "assigning" | "distributed" | "computing" | "verifying" | "completed" | "failed";

export type WorkloadSize = "small" | "medium" | "large";

export interface DistributedJob {
  id: string;
  /** What is actually computed. Labeled honestly; see REAL_VS_SIMULATED.md. */
  workload: { kind: "matmul_u32"; label: string; description: string; unitDims: { m: number; n: number; k: number } };
  size: WorkloadSize;
  status: DistributedJobStatus;
  redundancy: 1 | 2;
  createdAt: number;
  completedAt?: number;
  units: WorkUnit[];
  /** Distinct nodes with at least one assigned unit. */
  nodeIds: string[];
  totals: {
    workUnits: number;
    verified: number;
    failed: number;
    reassigned: number;
    computeUnits: number;
    nodesUsed: number;
    /** createdAt → completedAt. */
    latencyMs?: number;
  };
  failReason?: string;
  source: "real";
  lifecycle: { stage: DistributedJobStatus; at: number; detail?: string }[];
  /** Set when the job was created by a compute order through the routing engine. */
  orderId?: string;
  decisionId?: string;
  /**
   * Set when the job is compute attached to a chat/inference request: a verification workload sized by
   * that request and dispatched to the browser network after it completed. It did NOT produce the answer.
   */
  attachedTo?: { orderId: string; model: string; inputUnits: number; outputUnits: number };
  /**
   * Set when the operator scheduled this job to keep the fleet exercised. There is no customer and no
   * customer charge; nodes are paid for the verified units from the hourly pool like any other work.
   */
  scheduled?: { by: "operator"; reason: string };
}

export type NetworkEvent =
  | { type: "receipt.issued"; at: number; receipt: ComputeReceipt }
  | { type: "accounting.recorded"; at: number; event: AccountingEvent }
  | { type: "order.updated"; at: number; order: ComputeOrder }
  | { type: "node.joined"; at: number; node: ComputeNode }
  | { type: "node.left"; at: number; nodeId: string; memoryGb: number; reason?: "left" | "lost" }
  | { type: "node.heartbeat"; at: number; nodeId: string }
  | { type: "node.verified"; at: number; nodeId: string; units: number; jobId?: string }
  | { type: "job.submitted"; at: number; job: ComputeJob }
  | { type: "job.completed"; at: number; job: ComputeJob }
  | { type: "pool.status"; at: number; poolId: string; nodes: number }
  | { type: "metrics"; at: number; patch: Partial<NetworkMetrics> }
  | { type: "djob.created"; at: number; job: DistributedJob }
  | { type: "djob.assigned"; at: number; job: DistributedJob }
  | { type: "work.started"; at: number; jobId: string; unitId: string; nodeId: string; job: DistributedJob }
  | { type: "work.completed"; at: number; jobId: string; unitId: string; nodeId: string; job: DistributedJob }
  | { type: "work.verified"; at: number; jobId: string; unitId: string; nodeId: string; units: number; job: DistributedJob }
  | { type: "work.failed"; at: number; jobId: string; unitId: string; nodeId: string; reason: string; job: DistributedJob }
  | { type: "work.reassigned"; at: number; jobId: string; unitId: string; fromNodeId: string; toNodeId: string; job: DistributedJob }
  | { type: "djob.completed"; at: number; job: DistributedJob }
  | { type: "djob.failed"; at: number; job: DistributedJob }
  // Native Brain Nodes (node/) and their inference jobs (services/coordinator).
  | { type: "nnode.updated"; at: number; node: PublicNativeNode; change: "registered" | "rejoined" | "state" | "offline" }
  | { type: "njob.updated"; at: number; job: PublicInferenceJob }
  | { type: "njob.assigned"; at: number; jobId: string; nodeId: string }
  | { type: "njob.progress"; at: number; jobId: string; nodeId: string; seq: number; delta: string; outputChars: number };

export type NetworkEventType = NetworkEvent["type"];
