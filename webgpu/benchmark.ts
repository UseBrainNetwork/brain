import type { WorkloadResult, WorkloadSpec } from "@/network/workloads";
import type { WebGPUBackend } from "./backend";

export interface BenchmarkProgress {
  phase: "warmup" | "probe" | "challenge" | "submitting";
  /** 0..1 */
  progress: number;
  /** Live, locally measured throughput in mix rounds/sec (untrusted, display only). */
  roundsPerSec?: number;
  sample?: number;
}

export interface LocalBenchmarkResult {
  spec: WorkloadSpec;
  result: WorkloadResult;
  gpuMs: number;
  probeRoundsPerSec: number;
}

const PROBE_THREADS = 1 << 20;
const PROBE_ROUNDS = 128;
const PROBE_PASSES = 6;

/**
 * Local probing only. The score that counts is computed by the server from its own clock
 * around a challenge it issued (see services/benchmark.ts); this just picks a sensible size.
 */
export async function probeThroughput(
  backend: WebGPUBackend,
  onProgress: (p: BenchmarkProgress) => void,
): Promise<number> {
  onProgress({ phase: "warmup", progress: 0.02 });
  await backend.warmup();
  let best = 0;
  for (let i = 0; i < PROBE_PASSES; i++) {
    const rounds = PROBE_ROUNDS * (i < 2 ? 1 : 4);
    const { gpuMs } = await backend.execute({
      kernel: "mix_u32",
      seed: 0xc0ffee + i,
      rounds,
      threads: PROBE_THREADS,
      blockSize: 1024,
    });
    const rps = (PROBE_THREADS * rounds) / Math.max(gpuMs, 0.05) * 1000;
    best = Math.max(best, rps);
    onProgress({ phase: "probe", progress: 0.05 + (0.35 * (i + 1)) / PROBE_PASSES, roundsPerSec: rps, sample: i });
  }
  return best;
}

export async function runChallenge(
  backend: WebGPUBackend,
  spec: WorkloadSpec,
  onProgress: (p: BenchmarkProgress) => void,
): Promise<{ result: WorkloadResult; gpuMs: number }> {
  onProgress({ phase: "challenge", progress: 0.45 });
  const out = await backend.execute(spec);
  onProgress({ phase: "submitting", progress: 0.9 });
  return out;
}
