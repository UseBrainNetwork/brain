/**
 * Deterministic, verifiable workloads shared by the browser executor and the server verifier.
 *
 * All arithmetic is wrapping u32 so results are bit-identical on every GPU vendor and in JS.
 * (Floating point results differ across hardware, which would make exact verification impossible.)
 */

import { NETWORK_MODELS, layerMacs } from "@/inference/config";

export type WorkloadSpec =
  | {
      kernel: "matmul_u32";
      m: number;
      n: number;
      k: number;
      seedA: number;
      seedB: number;
    }
  | {
      kernel: "mix_u32";
      seed: number;
      rounds: number;
      threads: number;
      blockSize: number;
    }
  | {
      /**
       * A pipeline stage of a network LLM session: `tokens` tokens through layers
       * [layerFrom, layerTo). f32 work, verified by replica tolerance (services/inference.ts),
       * never by exact hashes; it exists as a spec so the job ledger can account for it.
       */
      kernel: "llm_stage";
      model: string;
      layerFrom: number;
      layerTo: number;
      tokens: number;
    };

export interface WorkloadResult {
  kernel: WorkloadSpec["kernel"];
  /** matmul: one FNV-1a hash per output row. mix: one hash per block of threads. */
  hashes: number[];
}

/* ----------------------------------------------------------------- PRNG / hash */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export function fillU32(seed: number, length: number): Uint32Array<ArrayBuffer> {
  const next = mulberry32(seed);
  const out = new Uint32Array(length);
  for (let i = 0; i < length; i++) out[i] = next();
  return out;
}

export function fnv1a(values: Uint32Array, start = 0, end = values.length): number {
  let h = 0x811c9dc5;
  for (let i = start; i < end; i++) {
    const v = values[i];
    h = Math.imul(h ^ (v & 0xff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 8) & 0xff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 16) & 0xff), 0x01000193);
    h = Math.imul(h ^ (v >>> 24), 0x01000193);
  }
  return h >>> 0;
}

/* ----------------------------------------------------------------- matmul_u32 */

export function matmulInputs(spec: Extract<WorkloadSpec, { kernel: "matmul_u32" }>) {
  return {
    a: fillU32(spec.seedA, spec.m * spec.k),
    b: fillU32(spec.seedB, spec.k * spec.n),
  };
}

/** CPU reference for a single output row. Cost: O(n·k). */
export function matmulRowCpu(
  a: Uint32Array,
  b: Uint32Array,
  row: number,
  n: number,
  k: number,
): Uint32Array {
  const out = new Uint32Array(n);
  const base = row * k;
  for (let col = 0; col < n; col++) {
    let acc = 0;
    for (let i = 0; i < k; i++) acc = (acc + Math.imul(a[base + i], b[i * n + col])) >>> 0;
    out[col] = acc;
  }
  return out;
}

export function hashMatmulRows(c: Uint32Array, m: number, n: number): number[] {
  const hashes = new Array<number>(m);
  for (let r = 0; r < m; r++) hashes[r] = fnv1a(c, r * n, r * n + n);
  return hashes;
}

/* -------------------------------------------------------------------- mix_u32 */

/** One thread of the mix kernel. Must match MIX_WGSL exactly. */
export function mixThreadCpu(seed: number, index: number, rounds: number): number {
  let x = (seed ^ Math.imul(index, 0x85ebca6b)) >>> 0;
  for (let r = 0; r < rounds; r++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    x = (Math.imul(x, 0x9e3779b1) + index) >>> 0;
  }
  return x;
}

export function mixBlockHashCpu(
  spec: Extract<WorkloadSpec, { kernel: "mix_u32" }>,
  block: number,
): number {
  const vals = new Uint32Array(spec.blockSize);
  const start = block * spec.blockSize;
  for (let i = 0; i < spec.blockSize; i++) vals[i] = mixThreadCpu(spec.seed, start + i, spec.rounds);
  return fnv1a(vals);
}

export function hashMixBlocks(out: Uint32Array, blockSize: number): number[] {
  const blocks = Math.ceil(out.length / blockSize);
  const hashes = new Array<number>(blocks);
  for (let b = 0; b < blocks; b++) hashes[b] = fnv1a(out, b * blockSize, Math.min(out.length, (b + 1) * blockSize));
  return hashes;
}

/* --------------------------------------------------------------- accounting */

/** Server-side cost model: how much useful work a spec represents. Never client-reported. */
export function workloadOps(spec: WorkloadSpec): number {
  if (spec.kernel === "matmul_u32") return spec.m * spec.n * spec.k;
  if (spec.kernel === "llm_stage") {
    const m = NETWORK_MODELS[spec.model];
    return m ? layerMacs(m.config) * (spec.layerTo - spec.layerFrom) * spec.tokens : 0;
  }
  return spec.threads * spec.rounds;
}

/** Compute units credited for a verified workload. 1 unit ≈ 2^20 multiply-accumulates. */
export function workloadUnits(spec: WorkloadSpec): number {
  return Math.max(1, Math.round(workloadOps(spec) / 1_048_576));
}

/** Full CPU reference — only for small specs (tests, canaries). */
export function referenceResult(spec: WorkloadSpec): WorkloadResult {
  if (spec.kernel === "llm_stage") throw new Error("llm_stage has no hash reference; it is verified by replica tolerance");
  if (spec.kernel === "matmul_u32") {
    const { a, b } = matmulInputs(spec);
    const hashes: number[] = [];
    for (let r = 0; r < spec.m; r++) hashes.push(fnv1a(matmulRowCpu(a, b, r, spec.n, spec.k)));
    return { kernel: spec.kernel, hashes };
  }
  const blocks = Math.ceil(spec.threads / spec.blockSize);
  const hashes: number[] = [];
  for (let b = 0; b < blocks; b++) hashes.push(mixBlockHashCpu(spec, b));
  return { kernel: spec.kernel, hashes };
}
