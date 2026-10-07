import "server-only";
import type { ComputeClass } from "@/node/models";
import { filterAllowed } from "@/node/models";
import { DEFAULTS, NODE_ID_RE, type HardwareReport, type NodeCapabilities, type NodeState, type RegisterBody, type Telemetry } from "@/node/protocol";
import { eventBus } from "@/services/eventBus";
import { NodeError } from "@/services/nodes";
import { getStore } from "@/services/store";
import { nodeIdFor } from "./auth";

/**
 * Registry of native Brain Nodes (machines running node/). Separate from the browser-node table
 * (services/nodes.ts) because the two are different animals: a native node holds a model
 * server and talks a signed protocol; a browser tab runs WebGPU kernels against a cookie session.
 *
 * Everything under `reported` came from the node and is unverified. Everything under `measured`
 * was timed or counted by the coordinator from job records. Routing weights only the latter plus
 * hard filters on the former (a node claiming too little VRAM is simply not selected).
 */
export interface NativeNode {
  nodeId: string;
  publicKey: string;
  state: NodeState;
  reported: {
    hardware: HardwareReport;
    capabilities: NodeCapabilities;
    telemetry: Telemetry | null;
    agentVersion: string;
  };
  /** Operator wallet. `verified` flips only through the signed-message link flow; never on registration. */
  wallet: { address: string; verified: boolean } | null;
  region: string | null;
  registeredAt: number;
  lastHeartbeatAt: number;
  /** Heartbeats observed while the node was expected to be online; uptime = observed ÷ expected. */
  heartbeats: number;
  /** Accumulated milliseconds between consecutive on-time heartbeats. */
  uptimeMs: number;
  draining: boolean;
  measured: {
    jobsCompleted: number;
    jobsFailed: number;
    jobsTimedOut: number;
    /** Output tokens the coordinator counted from accepted responses (its own tokenizer-free estimate is not used; see receipts). */
    tokensGenerated: number;
    /** Sum of coordinator-timed execution durations, ms. */
    computeMs: number;
    /** Last 20 coordinator-timed tokens/s samples (completion tokens ÷ coordinator wall time). */
    tokPerSec: number[];
    /** Last 20 first-byte latencies from assignment to first progress, ms. */
    firstByteMs: number[];
    consecutiveFailures: number;
    /** Redundant-execution outcomes this node took part in (either side). */
    redundantMatched?: number;
    redundantMismatched?: number;
    /** Canary outcomes. Two consecutive failures = DEGRADED until one passes. */
    canaryPassed?: number;
    canaryFailed?: number;
    canaryFailStreak?: number;
  };
  lastCanaryAt?: number;
  jobsAtLastCanary?: number;
  /** Last time a benchmark job was created for this node, pass or fail. Throttles rescheduling. */
  lastBenchmarkAttemptAt?: number;
  /** Coordinator-timed benchmark (services/coordinator/benchmark.ts). score = decode tokens/s on the coordinator's clock. */
  benchmark: { score: number | null; computeClass: ComputeClass | null; basis: "unmeasured" | "coordinator-timed"; at: number | null; firstByteMs?: number | null; model?: string };
  /** 0–100 Brain Reliability Score, computed from `measured` and uptime. Starts neutral. */
  reputation: number;
  activeJobIds: string[];
  /** Last ~2 h of heartbeat samples (one per heartbeat, capped) for the provider dashboard charts. */
  history: TelemetrySample[];
  ipHash: string;
  banReason?: string;
}

export interface TelemetrySample {
  at: number;
  gpuUtilPct: number | null;
  vramUsedMb: number | null;
  load: number;
  activeJobs: number;
}
const HISTORY_MAX = 240;

/** What leaves the server. No key material, no ip hash. */
export interface PublicNativeNode {
  nodeId: string;
  state: NodeState;
  region: string | null;
  gpu: { model: string; vramTotalMb: number | null; count: number; source: string; mock: boolean } | null;
  backend: string;
  supportedModels: string[];
  loadedModels: string[];
  /** Operator-set ask, USD per 1M tokens; null = accepts network list price. A routing input. */
  askUsdPer1MTokens: number | null;
  telemetry: Telemetry | null;
  registeredAt: number;
  lastHeartbeatAt: number;
  uptimePct: number | null;
  measured: NativeNode["measured"];
  benchmark: NativeNode["benchmark"];
  reputation: number;
  activeJobs: number;
  walletLinked: boolean;
  history: TelemetrySample[];
  /** Always true; here so UI code cannot forget to say so. */
  hardwareIsReported: true;
}

export function publicNativeNode(n: NativeNode, now = Date.now()): PublicNativeNode {
  const g = n.reported.hardware.gpus[0];
  return {
    nodeId: n.nodeId,
    state: n.state,
    region: n.region,
    gpu: g ? { model: g.model, vramTotalMb: g.vramTotalMb, count: n.reported.hardware.gpus.length, source: g.source, mock: n.reported.hardware.mock } : null,
    backend: n.reported.capabilities.backend,
    supportedModels: n.reported.capabilities.supportedModels,
    loadedModels: n.reported.capabilities.loadedModels,
    askUsdPer1MTokens: n.reported.capabilities.askUsdPer1MTokens,
    telemetry: n.reported.telemetry,
    registeredAt: n.registeredAt,
    lastHeartbeatAt: n.lastHeartbeatAt,
    uptimePct: uptimePct(n, now),
    measured: n.measured,
    benchmark: n.benchmark,
    reputation: n.reputation,
    activeJobs: n.activeJobIds.length,
    walletLinked: Boolean(n.wallet?.verified),
    history: n.history ?? [],
    hardwareIsReported: true,
  };
}

export const uptimePct = (n: NativeNode, now = Date.now()) => {
  const span = now - n.registeredAt;
  return span < DEFAULTS.heartbeatMs ? null : Math.max(0, Math.min(100, (100 * n.uptimeMs) / span));
};

const store = () => getStore();
const KIND = "nnode" as const;

const save = (n: NativeNode) => store().putDoc(KIND, n.nodeId, n, { at: n.lastHeartbeatAt, key: n.state });

export const getNativeNode = (id: string) => store().getDoc<NativeNode>(KIND, id);

/** All native nodes, newest heartbeat first. Cached briefly per instance: every route reads it. */
const cache = globalThis as typeof globalThis & { __brainNNodes?: { at: number; value: Promise<NativeNode[]> } };
export function listNativeNodes(maxAgeMs = 2_000): Promise<NativeNode[]> {
  const now = Date.now();
  if (!cache.__brainNNodes || now - cache.__brainNNodes.at > maxAgeMs) {
    const value = store().listDocs<NativeNode>(KIND, { limit: 2_000 });
    cache.__brainNNodes = { at: now, value };
    value.catch(() => (cache.__brainNNodes = undefined));
  }
  return cache.__brainNNodes.value;
}
const invalidate = () => (cache.__brainNNodes = undefined);

const sanitizeCaps = (c: NodeCapabilities): NodeCapabilities => ({
  backend: c.backend === "vllm" ? "vllm" : "mock",
  supportedModels: filterAllowed(Array.isArray(c.supportedModels) ? c.supportedModels.map(String) : []).slice(0, 32),
  loadedModels: filterAllowed(Array.isArray(c.loadedModels) ? c.loadedModels.map(String) : []).slice(0, 32),
  maxConcurrency: Math.max(1, Math.min(16, Math.floor(Number(c.maxConcurrency) || 1))),
  region: typeof c.region === "string" && c.region ? c.region.slice(0, 32).toLowerCase() : null,
  askUsdPer1MTokens: typeof c.askUsdPer1MTokens === "number" && Number.isFinite(c.askUsdPer1MTokens) && c.askUsdPer1MTokens >= 0 ? c.askUsdPer1MTokens : null,
});

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 96) => (typeof v === "string" ? v.slice(0, max) : "");

/** Keeps only the fields we display; a node cannot smuggle anything else into the record. */
function sanitizeHardware(h: HardwareReport): HardwareReport {
  const gpus = (Array.isArray(h?.gpus) ? h.gpus : []).slice(0, 8).map((g, i) => ({
    index: i,
    model: str(g?.model) || "unknown",
    vramTotalMb: num(g?.vramTotalMb),
    vramUsedMb: num(g?.vramUsedMb),
    utilizationPct: num(g?.utilizationPct),
    temperatureC: num(g?.temperatureC),
    powerW: num(g?.powerW),
    driverVersion: str(g?.driverVersion, 32) || null,
    cudaVersion: str(g?.cudaVersion, 16) || null,
    source: (["nvidia-smi", "nvml", "mock", "none"] as const).includes(g?.source) ? g.source : "none",
  }));
  return {
    os: { platform: str(h?.os?.platform, 24), release: str(h?.os?.release, 48), arch: str(h?.os?.arch, 16) },
    cpu: { model: str(h?.cpu?.model), cores: Math.max(0, Math.floor(num(h?.cpu?.cores) ?? 0)) },
    ramTotalMb: Math.max(0, num(h?.ramTotalMb) ?? 0),
    ramFreeMb: num(h?.ramFreeMb),
    diskFreeGb: num(h?.diskFreeGb),
    gpus,
    cuda: h?.cuda === true,
    // A node that says mock, or whose only GPU source is mock, is mock. It cannot un-mock itself by lying once.
    mock: h?.mock === true || gpus.some((g) => g.source === "mock"),
  };
}

function sanitizeTelemetry(t: Telemetry): Telemetry {
  const load = num(t?.load);
  return {
    gpuUtilPct: num(t?.gpuUtilPct),
    vramUsedMb: num(t?.vramUsedMb),
    vramTotalMb: num(t?.vramTotalMb),
    temperatureC: num(t?.temperatureC),
    powerW: num(t?.powerW),
    load: load == null ? 0 : Math.max(0, Math.min(1, load)),
    activeJobs: Math.max(0, Math.floor(num(t?.activeJobs) ?? 0)),
    loadedModels: filterAllowed(Array.isArray(t?.loadedModels) ? t.loadedModels.map(String) : []),
    rttMs: num(t?.rttMs),
  };
}

const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** First contact binds key → id (trust on first use). Re-registration must be signed by the same key, which the route checks. */
export async function registerNativeNode(body: RegisterBody, ipHash: string, now = Date.now()): Promise<NativeNode> {
  if (typeof body.publicKey !== "string" || Buffer.from(body.publicKey, "base64").length !== 32) throw new NodeError("bad_public_key", 400);
  const nodeId = nodeIdFor(body.publicKey);
  if (body.nodeId !== nodeId || !NODE_ID_RE.test(nodeId)) throw new NodeError("node_id_mismatch", 400);
  const existing = await getNativeNode(nodeId);
  if (existing && existing.publicKey !== body.publicKey) throw new NodeError("node_id_taken", 409);
  if (existing?.banReason) throw new NodeError("banned", 403);
  const caps = sanitizeCaps(body.capabilities);
  const hardware = sanitizeHardware(body.hardware);
  // Mock nodes are a development tool. A public coordinator refuses them unless the operator opts in
  // (docker-compose does), so nobody can fill /network with labelled-but-fake nodes.
  if (hardware.mock && process.env.NODE_ENV === "production" && process.env.BRAIN_ALLOW_MOCK_NODES !== "1") throw new NodeError("mock_nodes_disabled", 403);
  if (hardware.mock) caps.supportedModels = caps.supportedModels.filter((m) => m === "brain/mock");
  else caps.supportedModels = caps.supportedModels.filter((m) => m !== "brain/mock");
  caps.loadedModels = caps.loadedModels.filter((m) => caps.supportedModels.includes(m));
  const wallet = typeof body.wallet === "string" && WALLET_RE.test(body.wallet) ? { address: body.wallet, verified: existing?.wallet?.address === body.wallet ? existing.wallet.verified : false } : (existing?.wallet ?? null);
  const n: NativeNode = {
    nodeId,
    publicKey: body.publicKey,
    state: caps.supportedModels.length ? "ONLINE" : "DEGRADED",
    reported: { hardware, capabilities: caps, telemetry: existing?.reported.telemetry ?? null, agentVersion: str(body.agentVersion, 24) },
    wallet,
    region: caps.region,
    registeredAt: existing?.registeredAt ?? now,
    lastHeartbeatAt: now,
    heartbeats: existing?.heartbeats ?? 0,
    uptimeMs: existing?.uptimeMs ?? 0,
    draining: false,
    measured: existing?.measured ?? { jobsCompleted: 0, jobsFailed: 0, jobsTimedOut: 0, tokensGenerated: 0, computeMs: 0, tokPerSec: [], firstByteMs: [], consecutiveFailures: 0 },
    benchmark: existing?.benchmark ?? { score: null, computeClass: null, basis: "unmeasured", at: null },
    reputation: existing?.reputation ?? 70,
    activeJobIds: [],
    history: existing?.history ?? [],
    ipHash,
  };
  await save(n);
  invalidate();
  eventBus.publish({ type: "nnode.updated", at: now, node: publicNativeNode(n, now), change: existing ? "rejoined" : "registered" });
  return n;
}

/** Health flags the coordinator derives; a node cannot set DEGRADED on itself except by misbehaving. */
function deriveState(n: NativeNode): NodeState {
  if (n.draining) return "DRAINING";
  const t = n.reported.telemetry;
  if (n.reported.capabilities.supportedModels.length === 0) return "DEGRADED";
  if (n.measured.consecutiveFailures >= 3) return "DEGRADED";
  if ((n.measured.canaryFailStreak ?? 0) >= 2) return "DEGRADED";
  if (t?.temperatureC != null && t.temperatureC >= 95) return "DEGRADED";
  if (n.activeJobIds.length >= n.reported.capabilities.maxConcurrency) return "BUSY";
  return "ONLINE";
}

export async function heartbeatNativeNode(nodeId: string, telemetry: Telemetry, caps: NodeCapabilities | undefined, draining: boolean | undefined, now = Date.now()): Promise<NativeNode> {
  const n = await getNativeNode(nodeId);
  if (!n) throw new NodeError("unknown_node", 404);
  if (n.banReason) throw new NodeError("banned", 403);
  const gap = now - n.lastHeartbeatAt;
  if (gap <= DEFAULTS.offlineAfterMs) n.uptimeMs += Math.max(0, gap);
  n.heartbeats++;
  n.lastHeartbeatAt = now;
  n.reported.telemetry = sanitizeTelemetry(telemetry);
  n.history = [...(n.history ?? []), { at: now, gpuUtilPct: n.reported.telemetry.gpuUtilPct, vramUsedMb: n.reported.telemetry.vramUsedMb, load: n.reported.telemetry.load, activeJobs: n.reported.telemetry.activeJobs }].slice(-HISTORY_MAX);
  if (caps) {
    const c = sanitizeCaps(caps);
    if (n.reported.hardware.mock) c.supportedModels = c.supportedModels.filter((m) => m === "brain/mock");
    else c.supportedModels = c.supportedModels.filter((m) => m !== "brain/mock");
    c.loadedModels = c.loadedModels.filter((m) => c.supportedModels.includes(m));
    n.reported.capabilities = c;
    n.region = c.region;
  } else {
    // Loaded models move with telemetry so the coordinator never assumes a model is resident.
    n.reported.capabilities.loadedModels = n.reported.telemetry.loadedModels.filter((m) => n.reported.capabilities.supportedModels.includes(m));
  }
  if (draining != null) n.draining = draining;
  // A node that has never been benchmarked has never been routed customer work ("not yet benchmarked")
  // and no canaries (those follow the benchmark), so any failure streak it carries came from benchmark
  // probes, which no longer count. Clear it; the counter restarts from real work.
  if (n.benchmark.basis === "unmeasured" && n.measured.jobsCompleted === 0 && n.measured.consecutiveFailures > 0 && !(n.measured.canaryFailStreak ?? 0)) n.measured.consecutiveFailures = 0;
  const prev = n.state;
  n.state = deriveState(n);
  await save(n);
  invalidate();
  if (prev !== n.state) eventBus.publish({ type: "nnode.updated", at: now, node: publicNativeNode(n, now), change: prev === "OFFLINE" ? "rejoined" : "state" });
  return n;
}

/** Marks silent nodes OFFLINE. Throttled per instance; every coordinator read calls it. */
const sweepAt = globalThis as typeof globalThis & { __brainNSweep?: number };
export async function sweepNativeNodes(now = Date.now()): Promise<NativeNode[]> {
  const all = await listNativeNodes();
  if (now - (sweepAt.__brainNSweep ?? 0) < 10_000) return all;
  sweepAt.__brainNSweep = now;
  const lost: NativeNode[] = [];
  for (const n of all) {
    if (n.state !== "OFFLINE" && now - n.lastHeartbeatAt > DEFAULTS.offlineAfterMs) {
      n.state = "OFFLINE";
      await save(n);
      lost.push(n);
      eventBus.publish({ type: "nnode.updated", at: now, node: publicNativeNode(n, now), change: "offline" });
    }
  }
  if (lost.length) invalidate();
  return all;
}

/** Nodes a router may consider right now. */
export async function routableNativeNodes(now = Date.now()) {
  return (await sweepNativeNodes(now)).filter((n) => n.state !== "OFFLINE" && !n.banReason);
}

/** Mutates a node under lock and persists it. Used by the job state machine for counters. */
export async function updateNativeNode(nodeId: string, fn: (n: NativeNode) => void): Promise<NativeNode | null> {
  return store().withLock(`nnode:${nodeId}`, async () => {
    const n = await getNativeNode(nodeId);
    if (!n) return null;
    fn(n);
    n.state = n.state === "OFFLINE" ? "OFFLINE" : deriveState(n);
    n.reputation = reliabilityScore(n);
    await save(n);
    invalidate();
    return n;
  });
}

/**
 * 0–100 Brain Reliability Score from coordinator-measured history only. Belongs to the node id,
 * not the wallet. Neutral (70) until the node has done work; moves with completion rate, timeouts
 * and uptime. Routing uses it as one input (services/router).
 */
export function reliabilityScore(n: NativeNode, now = Date.now()): number {
  const m = n.measured;
  const done = m.jobsCompleted + m.jobsFailed + m.jobsTimedOut;
  if (done === 0) return 70;
  const completion = m.jobsCompleted / done;
  const timeouts = m.jobsTimedOut / done;
  const up = (uptimePct(n, now) ?? 100) / 100;
  // Confidence grows with history: the first jobs move the score less.
  const weight = Math.min(1, done / 20);
  const raw = 100 * (0.6 * completion + 0.2 * (1 - timeouts) + 0.2 * up);
  let score = 70 * (1 - weight) + raw * weight;
  // Verification probes: each mismatch or failed canary costs more than a completed job earns back.
  const rm = m.redundantMatched ?? 0;
  const rx = m.redundantMismatched ?? 0;
  const cp = m.canaryPassed ?? 0;
  const cf = m.canaryFailed ?? 0;
  if (rm + rx > 0) score -= 20 * (rx / (rm + rx));
  if (cp + cf > 0) score -= 30 * (cf / (cp + cf));
  return Math.round(Math.max(0, Math.min(100, score)));
}
