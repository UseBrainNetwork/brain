/**
 * Requester ids for coordinator-initiated jobs. Kept dependency-free: jobs.ts, benchmark.ts and
 * verify.ts all import this, and they import each other for behaviour, so the constants must not
 * live in any of them (ES module cycles evaluate top-level bindings lazily and would throw).
 *
 * Every probe is unpaid: no receipt, no accounting line, no customer. They exist to measure nodes.
 */
export const BENCHMARK_REQUESTER = "coordinator:benchmark";
export const VERIFY_REQUESTER = "coordinator:verify";
export const CANARY_REQUESTER = "coordinator:canary";

export type ProbeKind = "inference" | "benchmark" | "verify" | "canary";

export const probeKind = (j: { requesterId: string }): ProbeKind =>
  j.requesterId === BENCHMARK_REQUESTER ? "benchmark" : j.requesterId === VERIFY_REQUESTER ? "verify" : j.requesterId === CANARY_REQUESTER ? "canary" : "inference";

export const isProbeJob = (j: { requesterId: string }) => probeKind(j) !== "inference";
