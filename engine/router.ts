import type { ExecutionEstimate, PrivacyRequirement, ProviderTrust, RoutingMode, RoutingWeights, ScoredEstimate } from "@/domain/economy";

/**
 * BRAIN AUTO route selection. Pure function over estimates so it is testable without providers.
 *
 *   normalizedCost     = (cost − min) / (max − min) over eligible known costs        (UNKNOWN ⇒ unknownPenalty)
 *   normalizedLatency  = (latency − min) / (max − min) over eligible known latencies (UNKNOWN ⇒ unknownPenalty)
 *   reliabilityPenalty = 1 − estimatedReliability
 *   qualityPenalty     = 1 − qualityTier                                              (UNKNOWN ⇒ unknownPenalty)
 *   score = Σ weight · penalty                                                        (lower is better)
 *
 * Hard constraints are applied before scoring and never traded against score:
 *   supported, available, BROWSER_ONLY, maxCost, maxLatency, privacy.
 * Unknown values are penalised, never treated as free, instant or perfect.
 *
 * COMMUNITY is the one mode with an ordering rule on top of the score: an eligible community GPU
 * node (NATIVE_NETWORK, real model) is taken first, and the AUTO ranking decides everything after
 * it, including the fallback when the node fails. It exists so the people who plug GPUs into the
 * network get the traffic that can go to them; the privacy gate still applies unchanged, so only
 * PUBLIC requests ever reach a node this way.
 */

export const modeWeights: Record<RoutingMode, RoutingWeights> = {
  AUTO: { costWeight: 0.4, latencyWeight: 0.25, reliabilityWeight: 0.25, qualityWeight: 0.1, unknownPenalty: 0.75 },
  CHEAP: { costWeight: 0.8, latencyWeight: 0.05, reliabilityWeight: 0.15, qualityWeight: 0, unknownPenalty: 1 },
  FAST: { costWeight: 0.05, latencyWeight: 0.8, reliabilityWeight: 0.15, qualityWeight: 0, unknownPenalty: 1 },
  QUALITY: { costWeight: 0.05, latencyWeight: 0.05, reliabilityWeight: 0.3, qualityWeight: 0.6, unknownPenalty: 1 },
  BROWSER_ONLY: { costWeight: 0.4, latencyWeight: 0.25, reliabilityWeight: 0.25, qualityWeight: 0.1, unknownPenalty: 0.75 },
  COMMUNITY: { costWeight: 0.4, latencyWeight: 0.25, reliabilityWeight: 0.25, qualityWeight: 0.1, unknownPenalty: 0.75 },
};

/** A community node an order may be sent to first: the real network, serving a real model. */
export const isCommunityRoute = (e: { target: ExecutionEstimate["target"]; model?: string | null }) => e.target === "NATIVE_NETWORK" && e.model !== "brain/mock";

/** Which provider trust levels may see a request at each privacy level. */
export const privacyAllows: Record<PrivacyRequirement, ProviderTrust[]> = {
  PUBLIC: ["untrusted-distributed", "operator", "third-party"],
  STANDARD: ["operator", "third-party"],
  PRIVATE: ["operator"],
};

/** Trust level per execution target. The browser crowd never sees plaintext it is not allowed to. */
export const targetTrust: Record<ExecutionEstimate["target"], ProviderTrust> = {
  BROWSER_NETWORK: "untrusted-distributed",
  NATIVE_NETWORK: "untrusted-distributed",
  CLOUD_GPU: "operator",
  EXTERNAL_MODEL: "third-party",
};

export interface Constraints {
  maxCost?: number | null;
  maxLatency?: number | null;
  privacy?: PrivacyRequirement;
  /**
   * Whether the request carries plaintext a node could read. Verified matmul workloads carry
   * none (seeded synthetic matrices), so the privacy constraint does not apply to them.
   */
  carriesPlaintext?: boolean;
}

export function scoreEstimates(estimates: ExecutionEstimate[], mode: RoutingMode, c: Constraints = {}, weights: RoutingWeights = modeWeights[mode]): { ranked: ScoredEstimate[]; selected: ScoredEstimate | null; reason: string } {
  const privacy = c.privacy ?? "STANDARD";
  const rows: ScoredEstimate[] = estimates.map((e) => {
    const why: string[] = [];
    if (!e.supported) why.push("not supported");
    if (!e.available) why.push("unavailable");
    if (mode === "BROWSER_ONLY" && e.target !== "BROWSER_NETWORK") why.push("excluded by BROWSER_ONLY");
    if (c.carriesPlaintext !== false && !privacyAllows[privacy].includes(targetTrust[e.target])) why.push(`excluded by privacy ${privacy} (${targetTrust[e.target]})`);
    if (c.maxCost != null && e.estimatedCost != null && e.estimatedCost > c.maxCost) why.push(`over maxCost (${e.estimatedCost.toFixed(4)} > ${c.maxCost})`);
    if (c.maxLatency != null && e.estimatedLatency != null && e.estimatedLatency > c.maxLatency) why.push(`over maxLatency (${Math.round(e.estimatedLatency)}ms > ${c.maxLatency}ms)`);
    return {
      ...e,
      notes: [...e.notes, ...why],
      eligible: why.length === 0,
      score: Infinity,
      normalizedCost: 0,
      normalizedLatency: 0,
      reliabilityPenalty: 1 - e.estimatedReliability,
      qualityPenalty: e.qualityTier == null ? weights.unknownPenalty : 1 - e.qualityTier,
    };
  });
  const eligible = rows.filter((r) => r.eligible);
  const minmax = (xs: number[]) => (xs.length ? { lo: Math.min(...xs), hi: Math.max(...xs) } : { lo: 0, hi: 0 });
  const norm = (v: number | null, { lo, hi }: { lo: number; hi: number }) => (v == null ? weights.unknownPenalty : hi > lo ? (v - lo) / (hi - lo) : 0);
  const costs = minmax(eligible.flatMap((r) => (r.estimatedCost == null ? [] : [r.estimatedCost])));
  const lats = minmax(eligible.flatMap((r) => (r.estimatedLatency == null ? [] : [r.estimatedLatency])));
  for (const r of eligible) {
    r.normalizedCost = norm(r.estimatedCost, costs);
    r.normalizedLatency = norm(r.estimatedLatency, lats);
    r.score = weights.costWeight * r.normalizedCost + weights.latencyWeight * r.normalizedLatency + weights.reliabilityWeight * r.reliabilityPenalty + weights.qualityWeight * r.qualityPenalty;
  }
  const ranked = [...rows].sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.score - b.score || b.confidence - a.confidence);
  // COMMUNITY: a community GPU node that can take the request goes first; the score orders the rest.
  let community = false;
  if (mode === "COMMUNITY") {
    const i = ranked.findIndex((r) => r.eligible && isCommunityRoute(r));
    if (i > 0) ranked.unshift(...ranked.splice(i, 1));
    community = i >= 0;
    if (community) ranked[0].notes = [...ranked[0].notes, "COMMUNITY: community GPU node taken first"];
  }
  const selected = ranked.find((r) => r.eligible) ?? null;
  const fmtCost = (v: number | null) => (v == null ? "UNKNOWN" : `$${v.toFixed(4)}`);
  const fmtLat = (v: number | null) => (v == null ? "UNKNOWN" : `${Math.round(v)}ms`);
  const reason = selected
    ? `${mode}: ${selected.provider} ${community ? "is a community GPU node (taken first), scored" : "scored"} ${selected.score.toFixed(3)} (cost ${fmtCost(selected.estimatedCost)}, latency ${fmtLat(selected.estimatedLatency)}, reliability ${(selected.estimatedReliability * 100).toFixed(0)}%${selected.qualityTier != null ? `, quality tier ${selected.qualityTier.toFixed(2)}` : ""})` +
      (eligible.length > 1 ? ` over ${eligible.length - 1} other eligible target${eligible.length > 2 ? "s" : ""}` : "") +
      (mode === "COMMUNITY" && !community ? " · no community GPU node could take it; AUTO ranking" : "") +
      ` · privacy ${privacy}`
    : `no eligible target: ${rows.map((r) => `${r.provider} (${r.notes.at(-1) ?? "ineligible"})`).join("; ")}`;
  return { ranked, selected, reason };
}

/** Plain-language version of why a target won, for consumer surfaces. */
export function selectionReason(mode: RoutingMode, selected: ScoredEstimate, eligibleCount: number): string {
  if (eligibleCount <= 1) return "Only route that met the requirements";
  switch (mode) {
    case "CHEAP":
      return "Lowest cost within requirements";
    case "FAST":
      return "Lowest expected latency within requirements";
    case "QUALITY":
      return "Highest configured quality tier within requirements";
    case "BROWSER_ONLY":
      return "Browser network requested";
    case "COMMUNITY":
      return isCommunityRoute(selected) ? "Community GPU node, taken first" : "No community GPU node could take it; best balance of cost, latency and reliability";
    default:
      return selected.normalizedCost <= selected.normalizedLatency ? "Best balance of cost, latency and reliability (cost-led)" : "Best balance of cost, latency and reliability (latency-led)";
  }
}
