import "server-only";
import { modelSpec } from "@/node/models";
import { routableNativeNodes, type NativeNode } from "@/services/coordinator/registry";
import { scoreNodes, type RouteCandidate, type RoutingResult, type Workload } from "./score";

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Registry record → routing view. Only coordinator-measured speed enters; reported VRAM is a hard filter only. */
export function candidateOf(n: NativeNode, excluded: ReadonlySet<string> = new Set()): RouteCandidate {
  const vram = n.reported.hardware.gpus.reduce<number | null>((s, g) => (g.vramTotalMb == null ? s : (s ?? 0) + g.vramTotalMb), null);
  return {
    nodeId: n.nodeId,
    state: excluded.has(n.nodeId) ? "DRAINING" : n.state,
    supportedModels: n.reported.capabilities.supportedModels,
    loadedModels: n.reported.capabilities.loadedModels,
    vramTotalMb: vram,
    activeJobs: n.activeJobIds.length,
    maxConcurrency: n.reported.capabilities.maxConcurrency,
    tokPerSec: median(n.measured.tokPerSec),
    benchmarkScore: n.benchmark.score,
    reputation: n.reputation,
    rttMs: n.reported.telemetry?.rttMs ?? null,
    region: n.region,
    askUsdPer1MTokens: n.reported.capabilities.askUsdPer1MTokens,
    queueDepth: 0,
  };
}

export function workloadFor(model: string, opts: Partial<Workload> = {}): Workload {
  const spec = modelSpec(model);
  return { model, minVramMb: spec?.minVramMb ?? null, ...opts };
}

/** Routes against the live registry. Never throws on capacity: the caller reads `selected`. */
export async function routeToNativeNode(model: string, opts: Partial<Workload> & { exclude?: string[] } = {}, now = Date.now()): Promise<RoutingResult & { candidates: RouteCandidate[] }> {
  const nodes = await routableNativeNodes(now);
  const excluded = new Set(opts.exclude ?? []);
  const candidates = nodes.map((n) => candidateOf(n, excluded));
  const { exclude: _e, ...rest } = opts;
  void _e;
  return { ...scoreNodes(candidates, workloadFor(model, rest)), candidates };
}
