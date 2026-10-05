import type { ExecutionResult, RouteDecision } from "@/domain/economy";

/**
 * BRAIN COMPILATION — the LEARN step at the end of REQUEST → … → RECEIPT → LEARN.
 *
 * What exists today: every decision and its outcome are persisted (decision docs, receipts,
 * metric samples), and engine/metrics.ts folds outcomes into the next estimates (measured
 * latency medians and reliability). That is the entire learning loop so far, and it is real.
 *
 * What does not exist: per-request-type routing priors, quality feedback, or any model that
 * tunes weights. This hook is where that lands. It is deliberately a no-op that records the
 * observation so nothing pretends to learn more than it does.
 */
export interface RouteObservation {
  decisionId: string;
  mode: RouteDecision["mode"];
  capability: string | undefined;
  selectedProvider: string | null;
  executedProvider: string | null;
  fellBack: boolean;
  ok: boolean;
  latencyMs: number | null;
  at: number;
}

const recent: RouteObservation[] = [];
const MAX = 200;

export function observeRoute(decision: RouteDecision, attempts: ExecutionResult[]): RouteObservation {
  const last = attempts.at(-1) ?? null;
  const o: RouteObservation = {
    decisionId: decision.decisionId,
    mode: decision.mode,
    capability: decision.request.capability,
    selectedProvider: decision.selected?.provider ?? null,
    executedProvider: last?.provider ?? null,
    fellBack: attempts.length > 1,
    ok: Boolean(last?.ok),
    latencyMs: last?.executionTimeMs ?? null,
    at: Date.now(),
  };
  recent.push(o);
  if (recent.length > MAX) recent.shift();
  return o;
}

/** In-memory, per-instance. Used by the BRAIN AUTO console to show fallback frequency. */
export function recentObservations() {
  return [...recent];
}
