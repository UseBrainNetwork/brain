import { describe, expect, it } from "vitest";
import { referenceResult, type WorkloadSpec } from "@/network/workloads";
import { compareRedundant, plausibleDuration, verifyCanary, verifySpotCheck } from "./verification";

const matmul: WorkloadSpec = { kernel: "matmul_u32", m: 32, n: 32, k: 32, seedA: 11, seedB: 22 };
const honest = referenceResult(matmul);
const allRows = Array.from({ length: matmul.m }, (_, i) => i);

describe("verification (adversarial contributors)", () => {
  it("accepts an honest result", () => {
    expect(verifySpotCheck(matmul, honest, [0, 7, 31]).ok).toBe(true);
    expect(verifyCanary(matmul, honest, honest.hashes).ok).toBe(true);
  });

  it("catches a node that skipped part of the work", () => {
    // Lazy node: computes the first half, fills the rest with zeros.
    const lazy = { ...honest, hashes: honest.hashes.map((h, i) => (i < 16 ? h : 0)) };
    expect(verifySpotCheck(matmul, lazy, allRows).ok).toBe(false);
    expect(verifySpotCheck(matmul, lazy, [20]).ok).toBe(false);
  });

  it("rejects results with the wrong shape or kernel", () => {
    expect(verifySpotCheck(matmul, { ...honest, hashes: honest.hashes.slice(0, 5) }, [0]).ok).toBe(false);
    expect(verifySpotCheck(matmul, { kernel: "mix_u32", hashes: honest.hashes }, [0]).ok).toBe(false);
  });

  it("rejects a canary with a single flipped bit", () => {
    const tampered = { ...honest, hashes: honest.hashes.map((h, i) => (i === 9 ? (h ^ 1) >>> 0 : h)) };
    expect(verifyCanary(matmul, tampered, honest.hashes).ok).toBe(false);
  });

  it("rejects replica disagreement and a single replica", () => {
    const other = { ...honest, hashes: honest.hashes.map((h, i) => (i === 3 ? h + 1 : h)) };
    expect(compareRedundant([honest, honest]).ok).toBe(true);
    expect(compareRedundant([honest, other]).ok).toBe(false);
    expect(compareRedundant([honest]).ok).toBe(false);
  });

  it("rejects physically implausible completion times", () => {
    const big: WorkloadSpec = { kernel: "matmul_u32", m: 512, n: 512, k: 512, seedA: 1, seedB: 2 };
    expect(plausibleDuration(big, 0.0001)).toBe(false);
    expect(plausibleDuration(big, 50)).toBe(true);
  });
});
