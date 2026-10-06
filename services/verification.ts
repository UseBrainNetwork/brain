import {
  fnv1a,
  matmulInputs,
  matmulRowCpu,
  mixBlockHashCpu,
  workloadOps,
  type WorkloadResult,
  type WorkloadSpec,
} from "@/network/workloads";
import { networkConfig } from "@/lib/config";

/**
 * Verification strategies. Contributors are assumed adversarial: nothing they report
 * (device, timings, completion) is trusted without one of these checks.
 */

export type VerificationOutcome =
  | { ok: true; method: VerificationMethod; checked: number }
  | { ok: false; method: VerificationMethod; reason: string };

export type VerificationMethod = "canary" | "spot-check" | "redundant";

/** Shape check — cheap rejection of malformed results before any recompute. */
function wellFormed(spec: WorkloadSpec, result: WorkloadResult): string | null {
  if (!result || result.kernel !== spec.kernel || !Array.isArray(result.hashes)) return "malformed";
  if (spec.kernel === "llm_stage") return "not-hash-verifiable";
  const expected = spec.kernel === "matmul_u32" ? spec.m : Math.ceil(spec.threads / spec.blockSize);
  if (result.hashes.length !== expected) return "wrong-length";
  if (!result.hashes.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffffffff)) return "malformed";
  return null;
}

/** Canary: server already knows the full answer. */
export function verifyCanary(spec: WorkloadSpec, result: WorkloadResult, expected: number[]): VerificationOutcome {
  const bad = wellFormed(spec, result);
  if (bad) return { ok: false, method: "canary", reason: bad };
  const ok = expected.every((h, i) => h === result.hashes[i]);
  return ok ? { ok: true, method: "canary", checked: expected.length } : { ok: false, method: "canary", reason: "mismatch" };
}

/**
 * Spot-check: recompute rows/blocks chosen with a CSPRNG *before* the job was issued and
 * kept secret. Skipping a fraction f of the work is caught with probability 1-(1-f)^k.
 */
export function verifySpotCheck(spec: WorkloadSpec, result: WorkloadResult, indices: number[]): VerificationOutcome {
  const bad = wellFormed(spec, result);
  if (bad) return { ok: false, method: "spot-check", reason: bad };
  if (spec.kernel === "matmul_u32") {
    const { a, b } = matmulInputs(spec);
    for (const r of indices) {
      if (fnv1a(matmulRowCpu(a, b, r, spec.n, spec.k)) !== result.hashes[r]) {
        return { ok: false, method: "spot-check", reason: `row ${r} mismatch` };
      }
    }
  } else if (spec.kernel === "mix_u32") {
    for (const blk of indices) {
      if (mixBlockHashCpu(spec, blk) !== result.hashes[blk]) {
        return { ok: false, method: "spot-check", reason: `block ${blk} mismatch` };
      }
    }
  }
  return { ok: true, method: "spot-check", checked: indices.length };
}

/** Redundant execution: the same spec run on ≥2 independent nodes must agree exactly. */
export function compareRedundant(results: WorkloadResult[]): VerificationOutcome {
  if (results.length < 2) return { ok: false, method: "redundant", reason: "insufficient-replicas" };
  const [first, ...rest] = results;
  const agree = rest.every((r) => r.hashes.length === first.hashes.length && r.hashes.every((h, i) => h === first.hashes[i]));
  return agree ? { ok: true, method: "redundant", checked: results.length } : { ok: false, method: "redundant", reason: "replica-disagreement" };
}

/** Results returned faster than physically plausible are rejected regardless of correctness. */
export function plausibleDuration(spec: WorkloadSpec, elapsedMs: number): boolean {
  return workloadOps(spec) / Math.max(elapsedMs, 0.001) <= networkConfig.jobs.maxPlausibleOpsPerMs;
}

/** Policy hook: when to replicate a job instead of spot-checking (needs ≥2 live nodes). */
export interface RedundancyPolicy {
  replicas(liveNodes: number, nodeReputation: number): number;
}

export const defaultRedundancyPolicy: RedundancyPolicy = {
  replicas: (liveNodes, rep) => (liveNodes >= 3 && rep < 0.6 ? 2 : 1),
};
