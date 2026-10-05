import type { ExecutionEstimate, Priority, RoutingMode, RoutingWeights, ScoredEstimate } from "@/domain/economy";

/**
 * BRAIN AUTO route selection. Pure function over estimates so it is testable without providers.
 *
 *   normalizedCost    = (cost − min) / (max − min) over eligible known costs      (UNKNOWN ⇒ unknownPenalty)
 *   normalizedLatency = (latency − min) / (max − min) over eligible known latencies (UNKNOWN ⇒ unknownPenalty)
 *   reliabilityPenalty = 1 − reliability
 *   score = costWeight·normalizedCost + latencyWeight·normalizedLatency + reliabilityWeight·reliabilityPenalty
 *
 * Lower is better. Hard constraints (modelSupported, available, maxCost, maxLatency, BROWSER_ONLY)
 * are applied before scoring. Unknown values are penalised, never treated as free or instant.
 */

export const modeWeights: Record<RoutingMode, RoutingWeights> = {
  AUTO: { costWeight: 0.45, latencyWeight: 0.3, reliabilityWeight: 0.25, unknownPenalty: 0.75 },
  CHEAPEST: { costWeight: 0.8, latencyWeight: 0.05, reliabilityWeight: 0.15, unknownPenalty: 1 },
  FASTEST: { costWeight: 0.05, latencyWeight: 0.8, reliabilityWeight: 0.15, unknownPenalty: 1 },
  BROWSER_ONLY: { costWeight: 0.45, latencyWeight: 0.3, reliabilityWeight: 0.25, unknownPenalty: 0.75 },
};

export const priorityMode: Record<Priority, RoutingMode> = { CHEAP: "CHEAPEST", FAST: "FASTEST", BALANCED: "AUTO" };

export interface Constraints {
  maxCost?: number | null;
  maxLatency?: number | null;
}

export function scoreEstimates(estimates: ExecutionEstimate[], mode: RoutingMode, c: Constraints = {}, weights: RoutingWeights = modeWeights[mode]): { ranked: ScoredEstimate[]; selected: ScoredEstimate | null; reason: string } {
  const rows: ScoredEstimate[] = estimates.map((e) => {
    const why: string[] = [];
    if (!e.modelSupported) why.push("model not supported");
    if (!e.available) why.push("unavailable");
    if (mode === "BROWSER_ONLY" && e.target !== "BROWSER_NETWORK") why.push("excluded by BROWSER_ONLY");
    if (c.maxCost != null && e.estimatedCost != null && e.estimatedCost > c.maxCost) why.push(`over maxCost (${e.estimatedCost.toFixed(4)} > ${c.maxCost})`);
    if (c.maxLatency != null && e.estimatedLatency != null && e.estimatedLatency > c.maxLatency) why.push(`over maxLatency (${Math.round(e.estimatedLatency)}ms > ${c.maxLatency}ms)`);
    return { ...e, notes: [...e.notes, ...why], eligible: why.length === 0, score: Infinity, normalizedCost: 0, normalizedLatency: 0, reliabilityPenalty: 1 - e.reliability };
  });
  const eligible = rows.filter((r) => r.eligible);
  const minmax = (xs: number[]) => (xs.length ? { lo: Math.min(...xs), hi: Math.max(...xs) } : { lo: 0, hi: 0 });
  const norm = (v: number | null, { lo, hi }: { lo: number; hi: number }) => (v == null ? weights.unknownPenalty : hi > lo ? (v - lo) / (hi - lo) : 0);
  const costs = minmax(eligible.flatMap((r) => (r.estimatedCost == null ? [] : [r.estimatedCost])));
  const lats = minmax(eligible.flatMap((r) => (r.estimatedLatency == null ? [] : [r.estimatedLatency])));
  for (const r of eligible) {
    r.normalizedCost = norm(r.estimatedCost, costs);
    r.normalizedLatency = norm(r.estimatedLatency, lats);
    r.score = weights.costWeight * r.normalizedCost + weights.latencyWeight * r.normalizedLatency + weights.reliabilityWeight * r.reliabilityPenalty;
  }
  const ranked = [...rows].sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.score - b.score || b.confidence - a.confidence);
  const selected = ranked.find((r) => r.eligible) ?? null;
  const reason = selected
    ? `${mode}: ${selected.provider} scored ${selected.score.toFixed(3)} (cost ${selected.estimatedCost == null ? "UNKNOWN" : `$${selected.estimatedCost.toFixed(4)}`}, latency ${selected.estimatedLatency == null ? "UNKNOWN" : `${Math.round(selected.estimatedLatency)}ms`}, reliability ${(selected.reliability * 100).toFixed(0)}%)` +
      (eligible.length > 1 ? ` over ${eligible.length - 1} other eligible target${eligible.length > 2 ? "s" : ""}` : "")
    : `no eligible target: ${rows.map((r) => `${r.provider} (${r.notes.at(-1) ?? "ineligible"})`).join("; ")}`;
  return { ranked, selected, reason };
}
