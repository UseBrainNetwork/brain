import type { ChatMessage, ChatOptions, ToolCall } from "./chat";
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
  | "unverified-provider-response"
  /**
   * A native Brain Node produced this. The coordinator checked the response hash, that the final
   * text equals the streamed text, token-count plausibility and wall time; it did not re-run the
   * model. Token counts are the node's claim.
   */
  | "node-reported";

/**
 * Canonical body of a Brain Compute Receipt for native-node work. Serialised with sorted keys
 * (`canonicalReceipt()`), hashed with sha256 and signed by the coordinator's ed25519 key. Built
 * so a batch of these hashes can later be anchored on Solana without putting tokens on-chain.
 */
export interface CanonicalReceiptBody {
  v: 1;
  jobId: string;
  nodeId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  executionMs: number;
  timestamp: number;
  requestHash: string;
  responseHash: string;
  hardwareClass: string;
  cost: { amount: number; currency: "USD" } | null;
}

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
  resultHashLabel: "sha256 of verified unit outputs" | "sha256 of provider response" | "sha256 of node response";
  /**
   * `none` for browser-pool and upstream receipts. Native-node receipts carry the coordinator's
   * ed25519 signature over `canonical.hash`; `signer` is the raw public key, base64. Chain anchoring is planned.
   */
  attestation: { kind: "none" } | { kind: "signature"; signer: string; signature: string } | { kind: "anchor"; chain: string; txId: string };
  /** Native-node receipts only: the exact bytes that were hashed and signed. */
  canonical?: { body: CanonicalReceiptBody; hash: string };
  source: Source;
  /** Money. null = unpriced / UNKNOWN. Never fabricated. */
  customerCost: Money | null;
  providerCompensation: Money | null;
  protocolRevenue: Money | null;
  /** Which execution target produced the result and how it was chosen. */
  route: { target: ExecutionTarget; providerId: string; decisionId?: string } | null;
  orderId?: string;
  /** Set when the receipt belongs to one step of a compound plan. */
  planId?: string;
  stepId?: string;
  /** Chat receipts: token usage as the upstream reported it, or estimated from characters. */
  tokens?: { prompt: number; completion: number; basis: "provider-reported" | "estimated-from-chars" | "node-reported" };
  /**
   * Native-node receipts: the privacy terms the request ran under. `pinnedNode` is the node the
   * customer designated (null = router's choice). `promptRetained: false` means the coordinator
   * scrubbed prompt and output from its records once the answer was delivered; only hashes remain.
   */
  privacy?: { level: PrivacyRequirement; pinnedNode: string | null; promptRetained: boolean };
  /**
   * Set on receipts for compute attached to a chat/inference request. The nodes on this receipt ran a
   * verification workload sized by that request; they did not produce the request's answer.
   */
  attachedTo?: { orderId: string; model: string };
  /** Operator-scheduled network workload: no customer. */
  scheduled?: { by: "operator"; reason: string };
  /**
   * Final outcome. VERIFIED: every unit was checked by this server. PARTIAL: some units failed or
   * were reassigned. COMPLETED: the result was delivered but BRAIN did not verify the computation
   * (an external provider's response, or a node-reported result); `verificationMethod` says which.
   * A FAILED job also gets a receipt so the failure is auditable.
   */
  status: "VERIFIED" | "PARTIAL" | "COMPLETED" | "FAILED";
}

/**
 * The status to show for a receipt. Receipts issued before COMPLETED existed carry VERIFIED with an
 * unverified method; they are shown as COMPLETED, which is what they were.
 */
export const receiptStatus = (r: Pick<ComputeReceipt, "status" | "verificationMethod">): ComputeReceipt["status"] =>
  r.status === "VERIFIED" && (r.verificationMethod === "unverified-provider-response" || r.verificationMethod === "node-reported") ? "COMPLETED" : r.status;


export interface Money {
  amount: number;
  currency: "USD";
  /** Where the number came from: configured list price, measured upstream price, or a payment. */
  basis: "list-price" | "provider-price" | "provider-reported" | "payment";
}

/* ------------------------------------------------------------- routing */

/**
 * Provider types = classes of execution supply. BROWSER_NETWORK is the crowd (untrusted, verified
 * by the server); NATIVE_NETWORK is community machines running a native worker (not connected yet);
 * CLOUD_GPU is operator-controlled; EXTERNAL_MODEL is a third-party model API.
 */
export type ExecutionTarget = "BROWSER_NETWORK" | "NATIVE_NETWORK" | "CLOUD_GPU" | "EXTERNAL_MODEL";
/** Legacy value stored in receipts/decisions before 2026-10-05. Normalise on read with `normalizeTarget`. */
export type LegacyExecutionTarget = ExecutionTarget | "EXTERNAL_PROVIDER";
export const normalizeTarget = (t: LegacyExecutionTarget): ExecutionTarget => (t === "EXTERNAL_PROVIDER" ? "EXTERNAL_MODEL" : t);

/** Who can see the plaintext of a request executed on this target. Drives the privacy constraint. */
export type ProviderTrust = "untrusted-distributed" | "operator" | "third-party";

/** What a provider can do. Capability ids are stable strings used by classify() and /capacity. */
export type Capability = "compute.matmul_u32" | "chat" | "chat.reasoning" | "embeddings" | "vision" | "image.generation" | "tools";

/**
 * Routing priority. AUTO balances; CHEAP/FAST/QUALITY bias; BROWSER_ONLY is a hard filter.
 * COMMUNITY takes a community GPU node whenever one can serve the request and otherwise falls back
 * to the AUTO ranking; it is the default for PUBLIC requests on the free plan (see lib/plans.ts).
 */
export type RoutingMode = "AUTO" | "CHEAP" | "FAST" | "QUALITY" | "BROWSER_ONLY" | "COMMUNITY";
/** Legacy aliases accepted on the API and in stored orders. */
export type LegacyRoutingMode = RoutingMode | "CHEAPEST" | "FASTEST" | "BALANCED";
export const normalizeMode = (m: LegacyRoutingMode | string | undefined | null): RoutingMode => {
  const u = String(m ?? "AUTO").toUpperCase();
  if (u === "CHEAPEST" || u === "CHEAP") return "CHEAP";
  if (u === "FASTEST" || u === "FAST") return "FAST";
  if (u === "QUALITY") return "QUALITY";
  if (u === "BROWSER_ONLY" || u === "BROWSER") return "BROWSER_ONLY";
  if (u === "COMMUNITY" || u === "GPU") return "COMMUNITY";
  return "AUTO";
};
/** @deprecated use RoutingMode. Kept so stored orders still type-check. */
export type Priority = "CHEAP" | "FAST" | "BALANCED" | "QUALITY";

/**
 * PUBLIC: content may be seen by anyone (benchmarks, synthetic workloads).
 * STANDARD: content must not be exposed to untrusted distributed nodes in plaintext.
 * PRIVATE: content may only run on operator-controlled infrastructure.
 */
export type PrivacyRequirement = "PUBLIC" | "STANDARD" | "PRIVATE";

export interface RequestConstraints {
  mode: RoutingMode;
  privacy: PrivacyRequirement;
  maxCost: number | null;
  maxLatency: number | null;
}

export type ExecutionRequest =
  | { kind: "compute"; workload: "matmul_u32"; size: "small" | "medium" | "large"; unitsPerNode?: number; redundancy?: 1 | 2; privacy?: PrivacyRequirement }
  | ({
      kind: "chat";
      model: string;
      messages: ChatMessage[];
      maxTokens?: number;
      temperature?: number;
      privacy?: PrivacyRequirement;
      /**
       * Customer-designated Brain Node (N-XXXXXXXX). The request goes to that node or nowhere: no
       * fallback to other nodes or to upstream providers. Choosing the node is choosing who may read
       * the prompt, so STANDARD and PRIVATE are allowed here where node models otherwise require PUBLIC.
       */
      node?: string;
      /** Set on stored copies of PRIVATE requests: messages is [] and messageCount says how many there were. */
      contentRedacted?: boolean;
      messageCount?: number;
    } & ChatOptions);

/** What BRAIN AUTO decided the request needs, before looking at any provider. */
export interface RequestClassification {
  capability: Capability;
  privacy: PrivacyRequirement;
  /** Approximate prompt + completion tokens for chat; work units for compute. */
  size: number;
  needsTools: boolean;
  /** Whether the work can be split into independent units (true for compute, false for a single chat turn). */
  parallelizable: boolean;
}

export interface ExecutionEstimate {
  provider: string;
  target: ExecutionTarget;
  /** The concrete model or kernel this provider would run. null when unsupported. */
  model: string | null;
  supported: boolean;
  available: boolean;
  /** USD for this request. null = UNKNOWN (no configured or measured price). */
  estimatedCost: number | null;
  costBasis: "list-price" | "provider-price" | null;
  /** ms. null = UNKNOWN (no measurements yet). */
  estimatedLatency: number | null;
  latencyBasis: "measured-median" | "measured-last" | null;
  /** 0..1 observed reliability (verified / attempted). */
  estimatedReliability: number;
  /** 0..1 free capacity on the target right now. */
  availableCapacity: number;
  /** Operator-configured quality tier 0..1 for QUALITY routing. null = UNKNOWN; BRAIN does not measure answer quality yet. */
  qualityTier: number | null;
  /** 0..1 confidence in this estimate overall. */
  confidence: number;
  notes: string[];
}

export interface RoutingWeights {
  costWeight: number;
  latencyWeight: number;
  reliabilityWeight: number;
  /** Weight on (1 − qualityTier). Only QUALITY mode uses a meaningful value. */
  qualityWeight: number;
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
  qualityPenalty: number;
}

export interface RouteDecision {
  decisionId: string;
  at: number;
  mode: RoutingMode;
  privacy?: PrivacyRequirement;
  weights: RoutingWeights;
  request: { kind: ExecutionRequest["kind"]; model: string; capability?: Capability };
  estimates: ScoredEstimate[];
  selected: { provider: string; target: ExecutionTarget } | null;
  reason: string;
  source: Source;
}

export interface ExecutionResult {
  ok: boolean;
  provider: string;
  target: ExecutionTarget;
  /** The concrete model/kernel that ran. */
  model?: string;
  jobId: string;
  receiptId: string;
  executionTimeMs: number;
  /** Chat only. */
  content?: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: { inputUnits: number; outputUnits: number };
  /** USD the customer accrues for this step, from the receipt. null = UNKNOWN. */
  cost?: Money | null;
  /** The receipt as issued, in memory, so a caller does not need to read it back from the store. */
  receipt?: ComputeReceipt;
  error?: string;
}

/* ------------------------------------------------------------- execution plans (compound intelligence) */

/**
 * One request may become several steps. Today classify() produces single-step plans; the shape
 * supports fan-out/fan-in graphs (e.g. 200 extraction steps → 20 analysis steps → 1 synthesis).
 * Nothing here is simulated: a plan is only created for a real order and every step that runs
 * produces a real receipt.
 */
export interface ExecutionStep {
  stepId: string;
  /** Human label, e.g. "extract", "analyse", "synthesise". */
  label: string;
  request: ExecutionRequest;
  classification: RequestClassification;
  constraints: RequestConstraints;
  /** Steps that must complete before this one can start. */
  dependsOn: ExecutionDependency[];
  status: "PENDING" | "ROUTING" | "EXECUTING" | "COMPLETED" | "FAILED" | "SKIPPED";
  decisionId?: string;
  result?: ExecutionResult;
  /** Every execution attempt for this step, in order: provider, retry index, outcome, wall time. */
  attempts?: ExecutionAttempt[];
  /** Why the step stopped trying, when it did not succeed: "budget exhausted", "fallback disabled", "stream already started". */
  stopReason?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface ExecutionAttempt {
  provider: string;
  target: ExecutionTarget;
  retry: number;
  ok: boolean;
  error?: string;
  ms: number;
  at: number;
}

export interface ExecutionDependency {
  stepId: string;
  /** How the upstream output feeds this step. "context" appends the text to the prompt; "none" is ordering only. */
  use: "context" | "none";
}

export interface ExecutionPlan {
  planId: string;
  orderId: string;
  createdAt: number;
  completedAt?: number;
  /** "single" today; "compound" when more than one step. */
  shape: "single" | "compound";
  steps: ExecutionStep[];
  /** Id of the step whose output is the order's final output. */
  finalStepId: string;
  status: "PENDING" | "EXECUTING" | "COMPLETED" | "FAILED";
  /** Sum of step costs when every step is priced, else null (UNKNOWN). */
  totalCost: Money | null;
  totalLatencyMs?: number;
  source: Source;
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
  /** @deprecated mirrors `mode`; kept for stored orders. */
  priority: Priority;
  mode: RoutingMode;
  privacy: PrivacyRequirement;
  /** Retry / fallback / budget policy the order ran under. Absent on orders stored before it existed. */
  policy?: { retries: number; fallback: boolean; timeoutMs: number | null };
  createdAt: number;
  completedAt?: number;
  status: OrderStatus;
  decisionId?: string;
  planId?: string;
  jobId?: string;
  receiptId?: string;
  error?: string;
  /** Every execution attempt across the plan, in order. Retries and fallbacks are visible here. */
  attempts?: ExecutionAttempt[];
  /** false on stored PRIVATE orders: prompt and output were not written to the database. */
  contentRetained?: boolean;
  /** Chat only: the returned text. */
  output?: string;
  /** Chat only: tool calls the model made instead of (or alongside) text. */
  toolCalls?: ToolCall[];
  finishReason?: string;
  source: Source;
}

/* ------------------------------------------------------------- accounting */

export type AccountingEventType =
  | "CREATOR_REWARD_RECEIVED"
  | "CUSTOMER_PAYMENT"
  /** Compensation owed to a compute provider (node). Named PROVIDER_COMPENSATION in the brief; the stored string is kept for existing records. */
  | "COMPUTE_PROVIDER_EARNED"
  | "PROTOCOL_REVENUE"
  | "INFRASTRUCTURE_COST"
  | "SUBSCRIPTION_PAYMENT";

export interface AccountingEvent {
  id: string;
  type: AccountingEventType;
  amount: number;
  currency: "USD" | "SOL";
  timestamp: number;
  relatedJobId?: string;
  relatedNodeId?: string;
  relatedReceiptId?: string;
  relatedCustomerId?: string;
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
  /** Subscription payments (SUBSCRIPTION_PAYMENT). Always empty until a payment processor exists. */
  subscriptionRevenue: SumCell;
  /** (customersPaid + subscriptionRevenue − providersEarned − infrastructureCost) / (customersPaid + subscriptionRevenue), or null. */
  networkMargin: number | null;
  /** USD per 1M compute units across compute receipts with a price, or null. */
  costPer1MUnits: number | null;
  /** USD per 1M tokens across chat receipts with a price, or null. */
  costPer1MTokens: number | null;
  /** Average customer cost per priced receipt (any workload), or null. */
  avgCostPerJob: number | null;
  /** Average upstream provider cost per chat receipt where the upstream price is known, or null. */
  avgProviderCostPerChat: number | null;
  pricedReceipts: number;
  events: number;
}

export interface SumCell {
  settled: number | null;
  accrued: number | null;
  count: number;
}

/* ------------------------------------------------------------- treasury */

/**
 * What the chain and the database say about contributor money. Nothing here is a running total the
 * app keeps by hand: the chain-side figures are rebuilt from protocol-wallet transactions by signature,
 * the liabilities are sums over settled epochs and claims, and balances are read from the chain.
 */
export interface CreatorRewardTreasury {
  /** On-chain SOL in the protocol wallet. null = RPC unreachable → UNKNOWN. */
  balance: number | null;
  /** Creator fees claimed into the protocol wallet (pump.fun vault → wallet transactions). */
  received: number;
  /** Other SOL that arrived in the protocol wallet (not creator fees). */
  deposited: number;
  /** SOL moved from the protocol wallet to the payout wallet. */
  payoutFunded: number;
  /** SOL that left the protocol wallet anywhere else. */
  withdrawn: number;
  /** Sum of every live epoch's distributed lamports: what the network has promised contributors. */
  allocated: number;
  /** Claims paid or in flight (pending, sent, confirmed). */
  distributed: number;
  /** allocated − distributed: promised and not yet claimed. Must be covered by the payout wallet. */
  pendingDistribution: number;
  /** The hot wallet claims are paid from, with its on-chain balance (null = UNKNOWN). */
  payoutWallet: { address: string; balance: number | null } | null;
  /** Fixed pool per epoch (BRAIN_EPOCH_POOL_SOL). null = not configured, nothing settles live. */
  poolPerEpoch: number | null;
  /** How many more epochs the payout wallet can fund after covering pendingDistribution. Negative = already short. null = unknown. */
  runwayEpochs: number | null;
  currency: "SOL";
  source: Source;
  adapter: "mock" | "manual" | "pumpfun";
  updatedAt: number;
  /** Transaction signatures (and operator notes) the chain-side figures were built from. Empty for mock. */
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
