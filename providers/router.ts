import type { Candidate, InferenceProvider } from "./types";

/**
 * Workload router. Filters candidates on hard constraints (model compatibility, availability),
 * then ranks by a weighted score over latency, cost, reliability and capacity.
 * Weights are configurable per request class.
 */

export interface RoutingWeights {
  latency: number;
  cost: number;
  reliability: number;
  capacity: number;
  /** Bias toward the browser network when it is eligible (network-first policy). */
  browserPreference: number;
}

export const defaultRoutingWeights: RoutingWeights = {
  latency: 0.3,
  cost: 0.3,
  reliability: 0.3,
  capacity: 0.1,
  browserPreference: 0.25,
};

export interface ScoredCandidate extends Candidate {
  eligible: boolean;
  score: number;
}

export interface RoutingDecision {
  model: string;
  ranked: ScoredCandidate[];
  selected: ScoredCandidate | null;
}

export function scoreCandidate(c: Candidate, w: RoutingWeights): number {
  const latency = 1 / (1 + c.estLatencyMs / 1000);
  // Unknown cost is treated as neutral rather than free.
  const cost = c.costPer1M == null ? 0.5 : 1 / (1 + c.costPer1M);
  return (
    w.latency * latency +
    w.cost * cost +
    w.reliability * c.reliability +
    w.capacity * c.capacity +
    (c.target === "BROWSER_NETWORK" ? w.browserPreference : 0)
  );
}

export function rankCandidates(model: string, candidates: Candidate[], w = defaultRoutingWeights): RoutingDecision {
  const ranked = candidates
    .map((c) => {
      const eligible = c.compatible && c.available;
      return { ...c, eligible, score: eligible ? scoreCandidate(c, w) : 0 };
    })
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
  return { model, ranked, selected: ranked.find((c) => c.eligible) ?? null };
}

export async function route(model: string, providers: InferenceProvider[], w = defaultRoutingWeights) {
  const candidates = await Promise.all(providers.map((p) => p.evaluate(model)));
  return rankCandidates(model, candidates, w);
}
