/**
 * Wire contract between a Brain Node (the native agent in node/src) and the coordinator
 * (services/coordinator, served from app/api/coordinator). Imported by both sides; it must stay
 * free of server-only and Node-only code.
 *
 * Trust model: everything a node sends about itself is a CLAIM. The coordinator stores it as
 * `reported` data, labels it as such and never lets it set a price, a reward or a reputation on
 * its own. Only coordinator-timed and coordinator-checked values feed routing weight or payouts.
 */

export const PROTOCOL_VERSION = 1;

/* ----------------------------------------------------------------- identity */

/** `N-` + 8 upper-case hex derived from the node's public key. Never from IP or wallet. */
export const NODE_ID_RE = /^N-[0-9A-F]{8}$/;

export const SIGNED_HEADERS = { node: "x-brain-node", ts: "x-brain-ts", sig: "x-brain-sig" } as const;

/** Requests signed later than this are rejected (clock skew allowance + replay window). */
export const SIGNATURE_TTL_MS = 60_000;

/**
 * What a node signs for every request. The body hash binds the signature to the payload; the
 * path binds it to the endpoint; the timestamp bounds replay.
 */
export const signingString = (method: string, pathname: string, ts: number, bodySha256Hex: string) => `brain-node-v1\n${method.toUpperCase()}\n${pathname}\n${ts}\n${bodySha256Hex}`;

/* ----------------------------------------------------------------- hardware */

export type GpuSource = "nvidia-smi" | "nvml" | "mock" | "none";

export interface GpuReport {
  index: number;
  model: string;
  vramTotalMb: number | null;
  vramUsedMb: number | null;
  utilizationPct: number | null;
  temperatureC: number | null;
  powerW: number | null;
  driverVersion: string | null;
  cudaVersion: string | null;
  source: GpuSource;
}

/** Node-reported, unverified. The coordinator never upgrades this to "measured". */
export interface HardwareReport {
  os: { platform: string; release: string; arch: string };
  cpu: { model: string; cores: number };
  ramTotalMb: number;
  ramFreeMb: number | null;
  diskFreeGb: number | null;
  gpus: GpuReport[];
  cuda: boolean;
  /** True when the agent runs in mock mode: the GPU below does not exist. */
  mock: boolean;
}

export type Backend = "mock" | "vllm";

export interface NodeCapabilities {
  backend: Backend;
  /** Models this node can serve (allowlisted ids). Loading may still be required. */
  supportedModels: string[];
  /** Models resident in memory right now. The coordinator never assumes a model is loaded. */
  loadedModels: string[];
  maxConcurrency: number;
  /** Free-form coarse region label chosen by the operator, e.g. "eu-west". Never a precise location. */
  region: string | null;
  /** Provider's ask, USD per 1M output tokens. null = no ask; routing treats it as unknown. */
  askUsdPer1MTokens: number | null;
}

export interface Telemetry {
  gpuUtilPct: number | null;
  vramUsedMb: number | null;
  vramTotalMb: number | null;
  temperatureC: number | null;
  powerW: number | null;
  /** 0..1 share of the node's concurrency slots in use. */
  load: number;
  activeJobs: number;
  loadedModels: string[];
  /** Round trip the node measured to the coordinator on its last heartbeat. */
  rttMs: number | null;
}

/* ----------------------------------------------------------------- node ↔ coordinator */

export type NodeState = "ONLINE" | "BUSY" | "DRAINING" | "OFFLINE" | "DEGRADED";

export interface RegisterBody {
  protocol: number;
  nodeId: string;
  /** Raw 32-byte ed25519 public key, base64. */
  publicKey: string;
  agentVersion: string;
  hardware: HardwareReport;
  capabilities: NodeCapabilities;
  /** Optional Solana address. Stored unverified until the operator signs a link message. */
  wallet?: string;
}

export interface RegisterReply {
  nodeId: string;
  state: NodeState;
  heartbeatMs: number;
  /** How long the coordinator will hold a work poll open before answering "nothing". */
  workPollMs: number;
  /** Models the coordinator will route to this node (intersection with the allowlist). */
  acceptedModels: string[];
}

export interface HeartbeatBody {
  telemetry: Telemetry;
  capabilities?: NodeCapabilities;
  draining?: boolean;
}

export interface HeartbeatReply {
  state: NodeState;
  serverTime: number;
  /** Set when the coordinator wants the node to stop taking work (operator drain, ban, version). */
  instruction?: "drain" | "stop";
}

export type JobState = "QUEUED" | "MATCHING" | "ASSIGNED" | "STARTING" | "RUNNING" | "VERIFYING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface ChatTurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** The slice of a job a node is allowed to see. No requester identity, no pricing internals. */
export interface JobPayload {
  jobId: string;
  model: string;
  messages: ChatTurn[];
  maxTokens: number;
  temperature: number;
  stop?: string[];
  /** Absolute coordinator time after which the result is discarded. */
  deadlineAt: number;
  /** Bytes of progress the node may buffer before it must flush (keeps streams responsive). */
  flushMs: number;
}

export interface WorkReply {
  job: JobPayload | null;
  /** Coordinator time, lets the node estimate skew. */
  serverTime: number;
}

export interface StartedBody {
  backend: Backend;
  /** True when the node had to load the model first. */
  loaded: boolean;
}

export interface ProgressBody {
  /** Monotonic per job, starting at 0. Gaps are a protocol error and fail the job. */
  seq: number;
  delta: string;
  /** Tokens produced so far according to the backend (reported, used for display and sanity only). */
  tokens: number;
}

export interface CompletedBody {
  content: string;
  finishReason: "stop" | "length" | "cancelled";
  /** Backend-reported token counts. Labelled as such on receipts; never a billing basis on their own. */
  usage: { prompt: number; completion: number };
  /** Wall time the backend spent, per the node's clock. The coordinator keeps its own timing too. */
  durationMs: number;
  /** sha256 of `content`. The coordinator recomputes it; a mismatch fails verification. */
  responseHash: string;
}

export interface FailedBody {
  reason: "model_unavailable" | "backend_error" | "timeout" | "cancelled" | "rejected" | "oom";
  detail?: string;
}

export const DEFAULTS = {
  heartbeatMs: 15_000,
  /** Silent this long → OFFLINE. Three missed heartbeats. */
  offlineAfterMs: 45_000,
  workPollMs: 20_000,
  /** ASSIGNED → node must report started within this, or the job is re-matched. */
  startWithinMs: 20_000,
  /** No progress for this long while RUNNING → FAILED timeout. */
  stallAfterMs: 60_000,
  flushMs: 200,
  maxAttempts: 2,
} as const;
