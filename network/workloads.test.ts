import { describe, expect, it } from "vitest";
import { fnv1a, matmulInputs, matmulRowCpu, mixBlockHashCpu, mixThreadCpu, referenceResult, workloadUnits } from "./workloads";

describe("workloads", () => {
  it("matmul reference matches a naive BigInt computation mod 2^32", () => {
    const spec = { kernel: "matmul_u32" as const, m: 4, n: 5, k: 6, seedA: 7, seedB: 9 };
    const { a, b } = matmulInputs(spec);
    for (let r = 0; r < spec.m; r++) {
      const row = matmulRowCpu(a, b, r, spec.n, spec.k);
      for (let c = 0; c < spec.n; c++) {
        let acc = 0n;
        for (let i = 0; i < spec.k; i++) acc += BigInt(a[r * spec.k + i]) * BigInt(b[i * spec.n + c]);
        expect(row[c]).toBe(Number(acc % 2n ** 32n));
      }
    }
  });

  it("mix thread is deterministic and seed-sensitive", () => {
    expect(mixThreadCpu(1, 5, 100)).toBe(mixThreadCpu(1, 5, 100));
    expect(mixThreadCpu(1, 5, 100)).not.toBe(mixThreadCpu(2, 5, 100));
  });

  it("reference result hashes are consistent with block hashing", () => {
    const spec = { kernel: "mix_u32" as const, seed: 42, rounds: 8, threads: 2048, blockSize: 1024 };
    const ref = referenceResult(spec);
    expect(ref.hashes).toHaveLength(2);
    expect(ref.hashes[1]).toBe(mixBlockHashCpu(spec, 1));
  });

  it("fnv1a changes when any word changes", () => {
    const a = new Uint32Array([1, 2, 3]);
    const b = new Uint32Array([1, 2, 4]);
    expect(fnv1a(a)).not.toBe(fnv1a(b));
  });

  it("credits units from the server cost model", () => {
    expect(workloadUnits({ kernel: "matmul_u32", m: 256, n: 256, k: 256, seedA: 1, seedB: 2 })).toBe(16);
  });
});
