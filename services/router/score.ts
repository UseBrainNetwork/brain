import type { NodeState } from "@/node/protocol";

/**
 * Node routing for native Brain Nodes. Pure and deterministic: same candidates + same workload →
 * same ranking. No randomness, no wall clock, no I/O. The coordinator builds candidates from the
 * registry (services/router/select.ts) and this module decides.
 *
 * Hard constraints reject; soft factors score. Unknown measurements score neutral (0.5) and are
 * named in `notes`, they are never guessed. The weights are explicit so a decision can be
 * explained on a receipt.
 */

export interface RouteCandidate {
  nodeId: string;
  state: NodeState;
  supportedModels: readonly string[];
  loadedModels: readonly string[];
  /** Node-reported total VRAM across GPUs, MB. null = not reported. */
  vramTotalMb: number | null;
  activeJobs: number;
  maxConcurrency: number;
  /** Coordinator-measured tokens/s median, if any. */
  tokPerSec: number | null;
  /** Coordinator benchmark, if measured. */
  benchmarkScore: number | null;
  /** 0–100 Brain Reliability Score. */
  reputation: number;
  rttMs: number | null;
  region: string | null;
  askUsdPer1MTokens: number | null;
  /** Number of jobs waiting on this node beyond those running (0 in V1: one queue per coordinator). */
  queueDepth: number;
}

export interface Workload {
  model: string;
  minVramMb: number | null;
  /** Preferred region: scored, not required, unless `requireRegion`. */
  region?: string | null;
  requireRegion?: boolean;
  /** Reject asks above this. */
  maxUsdPer1MTokens?: number | null;
  /** Reject nodes whose reported total VRAM is unknown. Default false: unknown VRAM passes with a note. */
  requireKnownVram?: boolean;
}

export interface RoutingWeights {
  capability: number;
  availability: number;
  latency: number;
  reputation: number;
  price: number;
}

export const DEFAULT_WEIGHTS: RoutingWeights = { capability: 0.3, availability: 0.25, latency: 0.15, reputation: 0.2, price: 0.1 };

export interface NodeScore {
  nodeId: string;
  eligible: boolean;
  rejections: string[];
  notes: string[];
  capability: number;
  availability: number;
  latency: number;
  reputation: number;
  price: number;
  total: number;
}

export interface RoutingResult {
  ranked: NodeScore[];
  selected: NodeScore | null;
  reason: string;
  weights: RoutingWeights;
}

export class CapacityError extends Error {
  readonly code = "no_capacity" as const;
  constructor(
    message: string,
    public readonly ranked: NodeScore[],
  ) {
    super(message);
  }
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const neutral = 0.5;

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export function scoreNodes(candidates: readonly RouteCandidate[], w: Workload, weights: RoutingWeights = DEFAULT_WEIGHTS): RoutingResult {
  // Normalisers over the eligible set so a lone node is not penalised for being incomparable.
  const eligibleRaw = candidates.filter((c) => rejections(c, w).length === 0);
  const maxTok = Math.max(0, ...eligibleRaw.map((c) => c.tokPerSec ?? 0));
  const maxBench = Math.max(0, ...eligibleRaw.map((c) => c.benchmarkScore ?? 0));
  const asks = eligibleRaw.map((c) => c.askUsdPer1MTokens).filter((x): x is number => x != null);
  const maxAsk = asks.length ? Math.max(...asks) : 0;
  const medianRtt = median(eligibleRaw.map((c) => c.rttMs).filter((x): x is number => x != null));

  const ranked: NodeScore[] = candidates.map((c) => {
    const rej = rejections(c, w);
    const notes: string[] = [];

    // Capability: is the model resident, and how fast is this node, as measured by us.
    let capability = c.loadedModels.includes(w.model) ? 1 : 0.6;
    if (!c.loadedModels.includes(w.model)) notes.push("model not loaded; node must load it first");
    if (c.tokPerSec != null && maxTok > 0) capability *= 0.5 + 0.5 * clamp01(c.tokPerSec / maxTok);
    else if (c.benchmarkScore != null && maxBench > 0) capability *= 0.5 + 0.5 * clamp01(c.benchmarkScore / maxBench);
    else {
      capability *= 0.5 + 0.5 * neutral;
      notes.push("speed unmeasured");
    }

    // Availability: free slots and queue.
    const slots = Math.max(1, c.maxConcurrency);
    const availability = clamp01(1 - c.activeJobs / slots) * clamp01(1 - c.queueDepth / (slots * 4));

    // Latency: heartbeat RTT relative to the pool, 300 ms = 0.
    let latency: number;
    if (c.rttMs == null) {
      latency = neutral;
      notes.push("rtt unmeasured");
    } else latency = clamp01(1 - c.rttMs / 300) * 0.7 + (medianRtt != null && c.rttMs <= medianRtt ? 0.3 : 0);
    if (w.region && c.region && c.region === w.region) latency = clamp01(latency + 0.2);

    const reputation = clamp01(c.reputation / 100);

    // Price: cheaper asks score higher; unknown is neutral and said so.
    let price: number;
    if (c.askUsdPer1MTokens == null) {
      price = neutral;
      notes.push("no price ask");
    } else price = maxAsk > 0 ? clamp01(1 - c.askUsdPer1MTokens / maxAsk) * 0.8 + 0.2 : 1;

    const total = rej.length ? 0 : weights.capability * capability + weights.availability * availability + weights.latency * latency + weights.reputation * reputation + weights.price * price;
    return { nodeId: c.nodeId, eligible: rej.length === 0, rejections: rej, notes, capability, availability, latency, reputation, price, total: Number(total.toFixed(6)) };
  });

  ranked.sort((a, b) => (b.eligible ? 1 : 0) - (a.eligible ? 1 : 0) || b.total - a.total || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  const selected = ranked.find((r) => r.eligible) ?? null;
  return { ranked, selected, reason: selected ? selectionReason(selected, ranked) : capacityReason(w, ranked), weights };
}

function rejections(c: RouteCandidate, w: Workload): string[] {
  const r: string[] = [];
  if (c.state === "OFFLINE") r.push("offline");
  else if (c.state === "DRAINING") r.push("draining");
  else if (c.state === "DEGRADED") r.push("degraded");
  else if (c.state === "BUSY" || c.activeJobs >= c.maxConcurrency) r.push("no free slot");
  if (!c.supportedModels.includes(w.model)) r.push(`does not serve ${w.model}`);
  if (w.minVramMb != null && w.minVramMb > 0) {
    if (c.vramTotalMb == null) {
      if (w.requireKnownVram) r.push("VRAM unknown");
    } else if (c.vramTotalMb < w.minVramMb) r.push(`VRAM ${Math.round(c.vramTotalMb / 1024)} GB < ${Math.ceil(w.minVramMb / 1024)} GB required`);
  }
  if (w.requireRegion && w.region && c.region !== w.region) r.push(`not in ${w.region}`);
  if (w.maxUsdPer1MTokens != null && c.askUsdPer1MTokens != null && c.askUsdPer1MTokens > w.maxUsdPer1MTokens) r.push("ask above budget");
  return r;
}

function selectionReason(s: NodeScore, ranked: NodeScore[]): string {
  const eligible = ranked.filter((r) => r.eligible).length;
  const parts = [`capability ${s.capability.toFixed(2)}`, `availability ${s.availability.toFixed(2)}`, `latency ${s.latency.toFixed(2)}`, `reputation ${s.reputation.toFixed(2)}`, `price ${s.price.toFixed(2)}`];
  return `${s.nodeId} scored ${s.total.toFixed(3)} (${parts.join(", ")}) over ${eligible} eligible node${eligible === 1 ? "" : "s"}`;
}

/** Human-readable capacity error: counts every reason nodes were rejected. */
export function capacityReason(w: Workload, ranked: NodeScore[]): string {
  if (!ranked.length) return `no Brain Nodes are registered that could serve ${w.model}`;
  const counts = new Map<string, number>();
  for (const r of ranked) for (const x of r.rejections) counts.set(x, (counts.get(x) ?? 0) + 1);
  const detail = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join("; ");
  return `0 of ${ranked.length} nodes can serve ${w.model} right now (${detail})`;
}

/** Throws CapacityError when nothing is eligible. */
export function selectNode(candidates: readonly RouteCandidate[], w: Workload, weights?: RoutingWeights): RoutingResult & { selected: NodeScore } {
  const r = scoreNodes(candidates, w, weights);
  if (!r.selected) throw new CapacityError(r.reason, r.ranked);
  return r as RoutingResult & { selected: NodeScore };
}
