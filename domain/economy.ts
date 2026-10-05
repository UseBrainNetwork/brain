/**
 * Economic layer domain model: proof of compute, routing, orders, accounting, reputation.
 *
 * Every record carries `source: "REAL" | "SIMULATED"`. Totals are computed per source and are
 * never mixed; see services/accounting.ts (`sumBy` filters on source) and the invariant tests.
 */

export type Source = "REAL" | "SIMULATED";

/* ------------------------------------------------------------- receipts */

export type WorkloadType = "matmul_u32" | "chat" | "embeddings";

export type VerificationMethod =
  /** Server recomputed secret rows of every unit and compared row hashes. */
  | "spot-check"
  /** Two nodes computed each unit; outputs compared, then spot-checked. */
  | "redundant+spot-check"
  /** The server knew the full answer in advance. */
  | "canary"
  /** External model provider response. BRAIN did not and cannot verify the computation. */
  | "unverified-provider-response";

export interface ComputeReceipt {
  receiptId: string;
  jobId: string;
  workloadType: WorkloadType;
  /** Model or kernel identifier, e.g. "brain/matmul-u32" or the upstream model name. */
  model: string;
  createdAt: number;
  completedAt: number;
  /** Anonymous node ids that produced verified work. Never IPs or wallets. */
  nodesUsed: string[];
  workUnits: number;
  verifiedWorkUnits: number;
  failedWorkUnits: number;
  reassignedWorkUnits: number;
  totalComputeUnits: number;
  executionTimeMs: number;
  verificationMethod: VerificationMethod;
  /** 0..1 probability that an incorrect unit would have been caught. 0 for unverified. */
  verificationConfidence: number;
  /**
   * sha256 over the ordered, server-verified unit outputs (row hashes) — an integrity digest
   * that lets anyone re-derive the same hash from the same outputs. It is NOT a cryptographic
   * proof of execution and is NOT signed or anchored yet; see `attestation`.
   */
  resultHash: string;
  resultHashLabel: "sha256 of verified unit outputs" | "sha256 of provider response";
  /** Reserved for future signatures / chain anchoring. Always `{ kind: "none" }` today. */
  attestation: { kind: "none" } | { kind: "signature"; signer: string; signature: string } | { kind: "anchor"; chain: string; txId: string };
  source: Source;
  /** Money. null = unpriced / UNKNOWN. Never fabricated. */
  customerCost: Money | null;
  providerCompensation: Money | null;
  protocolRevenue: Money | null;
  /** Which execution target produced the result and how it was chosen. */
  route: { target: ExecutionTarget; providerId: string; decisionId?: string } | null;
  orderId?: string;
  /** Final outcome. A FAILED job also gets a receipt so the failure is auditable. */
  status: "VERIFIED" | "PARTIAL" | "FAILED";
}

export interface Money {
  amount: number;
  currency: "USD";
  /** Where the number came from: configured list price, measured upstream price, or a payment. */
  basis: "list-price" | "provider-price" | "payment";
}

/* ------------------------------------------------------------- routing */

export type ExecutionTarget = "BROWSER_NETWORK" | "CLOUD_GPU" | "EXTERNAL_PROVIDER";
export type RoutingMode = "AUTO" | "CHEAPEST" | "FASTEST" | "BROWSER_ONLY";
export type Priority = "CHEAP" | "FAST" | "BALANCED";

export type ExecutionRequest =
  | { kind: "compute"; workload: "matmul_u32"; size: "small" | "medium" | "large"; unitsPerNode?: number; redundancy?: 1 | 2 }
  | { kind: "chat"; model: string; messages: { role: "system" | "user" | "assistant"; content: string }[]; maxTokens?: number; temperature?: number };

export interface ExecutionEstimate {
  provider: string;
  target: ExecutionTarget;
  /** USD for this request. null = UNKNOWN (no configured or measured price). */
  estimatedCost: number | null;
  costBasis: "list-price" | "provider-price" | null;
  /** ms. null = UNKNOWN (no measurements yet). */
  estimatedLatency: number | null;
  latencyBasis: "measured-median" | "measured-last" | null;
  /** 0..1 free capacity. */
  capacity: number;
  modelSupported: boolean;
  available: boolean;
  /** 0..1 confidence in this estimate overall. */
  confidence: number;
  /** 0..1 observed reliability (verified / attempted). */
  reliability: number;
  notes: string[];
}

export interface RoutingWeights {
  costWeight: number;
  latencyWeight: number;
  reliabilityWeight: number;
  /** Score used when a value is UNKNOWN (0 = best, 1 = worst). Unknowns are penalised, not assumed free. */
  unknownPenalty: number;
}

export interface ScoredEstimate extends ExecutionEstimate {
  eligible: boolean;
  /** Lower is better. */
  score: number;
  normalizedCost: number;
  normalizedLatency: number;
  reliabilityPenalty: number;
}

export interface RouteDecision {
  decisionId: string;
  at: number;
  mode: RoutingMode;
  weights: RoutingWeights;
  request: { kind: ExecutionRequest["kind"]; model: string };
  estimates: ScoredEstimate[];
  selected: { provider: string; target: ExecutionTarget } | null;
  reason: string;
  source: Source;
}

export interface ExecutionResult {
  ok: boolean;
  provider: string;
  target: ExecutionTarget;
  jobId: string;
  receiptId: string;
  executionTimeMs: number;
  /** Chat only. */
  content?: string;
  usage?: { inputUnits: number; outputUnits: number };
  error?: string;
}

export interface ProviderHealth {
  provider: string;
  target: ExecutionTarget;
  status: "UP" | "DEGRADED" | "DOWN" | "UNCONFIGURED";
  detail: string;
  checkedAt: number;
}

/* ------------------------------------------------------------- orders */

export type OrderStatus = "CREATED" | "ROUTING" | "EXECUTING" | "COMPLETED" | "FAILED" | "REJECTED";

export interface ComputeOrder {
  orderId: string;
  /** "operator" for demo-console orders, otherwise a customer id. */
  customerId: string;
  workload: WorkloadType;
  model: string;
  request: ExecutionRequest;
  maxCost: number | null;
  maxLatency: number | null;
  priority: Priority;
  mode: RoutingMode;
  createdAt: number;
  completedAt?: number;
  status: OrderStatus;
  decisionId?: string;
  jobId?: string;
  receiptId?: string;
  error?: string;
  /** Chat only: the returned text. */
  output?: string;
  source: Source;
}

/* ------------------------------------------------------------- accounting */

export type AccountingEventType = "CREATOR_REWARD_RECEIVED" | "CUSTOMER_PAYMENT" | "COMPUTE_PROVIDER_EARNED" | "PROTOCOL_REVENUE" | "INFRASTRUCTURE_COST";

export interface AccountingEvent {
  id: string;
  type: AccountingEventType;
  amount: number;
  currency: "USD" | "SOL";
  timestamp: number;
  relatedJobId?: string;
  relatedNodeId?: string;
  relatedReceiptId?: string;
  source: Source;
  /**
   * accrued: owed at list price, no money has moved. settled: backed by a payment/transfer
   * identified by `transactionReference`. Dashboards count both separately.
   */
  settlement: "accrued" | "settled";
  transactionReference?: string;
  note?: string;
}

export interface EconomicsSnapshot {
  source: Source;
  from: number;
  to: number;
  /** Sums. null = NOT ENOUGH DATA (no events of that type for this source). */
  customersPaid: SumCell;
  providersEarned: SumCell;
  creatorRewards: SumCell;
  protocolRevenue: SumCell;
  infrastructureCost: SumCell;
  /** (customersPaid + creatorRewards − providersEarned − infrastructureCost) / customersPaid, or null. */
  networkMargin: number | null;
  /** USD per 1M output units across receipts with a price, or null. */
  costPer1MUnits: number | null;
  events: number;
}

export interface SumCell {
  settled: number | null;
  accrued: number | null;
  count: number;
}

/* ------------------------------------------------------------- treasury */

export interface CreatorRewardTreasury {
  balance: number;
  received: number;
  allocated: number;
  distributed: number;
  pendingDistribution: number;
  currency: "SOL";
  source: Source;
  adapter: "mock" | "manual" | "pumpfun";
  updatedAt: number;
  /** Where the numbers came from (tx signatures, operator notes). Empty for mock. */
  references: string[];
}

/* ------------------------------------------------------------- reputation */

export interface NodeReputation {
  nodeId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  online: boolean;
  deviceClass: string;
  computeScore: number;
  jobsCompleted: number;
  jobsFailed: number;
  jobsVerified: number;
  /** verified / (verified + failed), null when nothing checked. */
  verificationRate: number | null;
  /** Heartbeats observed ÷ heartbeats expected while live, 0..1. */
  uptime: number;
  /** Median server-measured assign→return latency for distributed units, ms. null without data. */
  medianLatencyMs: number | null;
  computeUnits: number;
  /** Units reassigned away from this node ÷ units assigned to it. */
  reassignmentRate: number | null;
  /** 0..1, the server's running reputation. */
  reputationScore: number;
  source: Source;
}

/* ------------------------------------------------------------- capability */

export type CapabilityState = "AVAILABLE" | "LIMITED" | "UNAVAILABLE" | "EXPERIMENTAL";

export interface NetworkCapability {
  id: string;
  label: string;
  description: string;
  state: CapabilityState;
  /** Why it is in that state, derived from real data. */
  reasons: string[];
  requirements: { label: string; required: string; current: string; met: boolean }[];
  /** Real measurements that drove the decision. */
  evidence: { compatibleNodes: number; recentSuccessRate: number | null; recentJobs: number; capacityScore: number };
}

export interface CapabilityLevel {
  level: number;
  label: string;
  reached: boolean;
  requirements: { label: string; required: string; current: string; met: boolean }[];
}

/* ------------------------------------------------------------- customers */

export interface Customer {
  customerId: string;
  label: string;
  createdAt: number;
  /** Requests per minute. */
  rateLimit: number;
  source: Source;
}

export interface ApiKey {
  keyId: string;
  customerId: string;
  /** sha256 of the secret. The secret is shown once and never stored. */
  keyHash: string;
  prefix: string;
  createdAt: number;
  revokedAt?: number;
  lastUsedAt?: number;
}

export interface CustomerRequestRecord {
  id: string;
  customerId: string;
  at: number;
  model: string;
  endpoint: "chat.completions" | "embeddings" | "compute";
  route: { target: ExecutionTarget; providerId: string } | null;
  nodesUsed: string[];
  inputUnits: number;
  outputUnits: number;
  cost: number | null;
  latencyMs: number;
  receiptId: string | null;
  ok: boolean;
  source: Source;
}

/* ------------------------------------------------------------- epochs (v2) */

export interface RewardEpochV2 {
  epochId: string;
  startsAt: number;
  endsAt: number;
  finalizedAt: number;
  /** Pool in SOL lamports or USD cents? We use SOL lamports to match the claim path. */
  poolLamports: number;
  distributedLamports: number;
  participants: number;
  totalVerifiedCompute: number;
  /** sha256 over the sorted allocation rows: anyone can recompute it from the public allocation list. */
  resultHash: string;
  config: Record<string, number>;
  source: Source;
  allocations: RewardEpochV2Allocation[];
}

export interface RewardEpochV2Allocation {
  nodeId: string;
  wallet: string | null;
  verifiedCompute: number;
  holdingMultiplier: number;
  qualityMultiplier: number;
  weight: number;
  share: number;
  lamports: number;
  capped: boolean;
}
