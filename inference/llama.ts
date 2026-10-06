import type { LlamaConfig } from "./config";
import { QK, entryToF32, f16Bits, ggufLayerNames, type LoadedEntries, type WeightEntry } from "./gguf";

/**
 * CPU reference for the Llama / Qwen3 decoder (HF semantics: RMSNorm, non-interleaved RoPE with
 * rotate_half, optional per-head q/k RMSNorm, grouped-query attention, SwiGLU MLP, tied output
 * projection). f32 math, row-major, weights stored as [out, in] exactly as in the checkpoint
 * (dequantised from the same blocks the GPU holds).
 *
 * Used for: the tolerance oracle for the GPU kernels and the integration test against real weights.
 */

export interface LayerWeights {
  ln1: Float32Array;
  wq: Float32Array;
  wk: Float32Array;
  wv: Float32Array;
  wo: Float32Array;
  qNorm?: Float32Array;
  kNorm?: Float32Array;
  ln2: Float32Array;
  wgate: Float32Array;
  wup: Float32Array;
  wdown: Float32Array;
}

export function layerWeightsFrom(t: LoadedEntries, layer: number): LayerWeights {
  const n = ggufLayerNames(layer);
  const f = (name: string) => entryToF32(t.get(name));
  return {
    ln1: f(n.ln1),
    wq: f(n.wq),
    wk: f(n.wk),
    wv: f(n.wv),
    wo: f(n.wo),
    qNorm: t.has(n.qNorm) ? f(n.qNorm) : undefined,
    kNorm: t.has(n.kNorm) ? f(n.kNorm) : undefined,
    ln2: f(n.ln2),
    wgate: f(n.wgate),
    wup: f(n.wup),
    wdown: f(n.wdown),
  };
}

/** Per-layer key/value cache: [capacity, kvDim] each. */
export interface KvCache {
  k: Float32Array;
  v: Float32Array;
  len: number;
  capacity: number;
}

export function createKv(cfg: LlamaConfig, capacity: number): KvCache {
  const kvDim = cfg.headDim * cfg.kvHeads;
  return { k: new Float32Array(capacity * kvDim), v: new Float32Array(capacity * kvDim), len: 0, capacity };
}

/* ------------------------------------------------------------------ primitives */

export function rmsnorm(x: Float32Array, w: Float32Array, eps: number, seq: number, dim: number, out: Float32Array = new Float32Array(seq * dim)): Float32Array {
  for (let s = 0; s < seq; s++) {
    const o = s * dim;
    let ss = 0;
    for (let i = 0; i < dim; i++) ss += x[o + i] * x[o + i];
    const inv = 1 / Math.sqrt(ss / dim + eps);
    for (let i = 0; i < dim; i++) out[o + i] = Math.fround(x[o + i] * inv) * w[i];
  }
  return out;
}

/** y[seq, out] = x[seq, in] · W[out, in]^T (+ y if `accumulate`). */
export function matmulT(x: Float32Array, w: Float32Array, seq: number, inDim: number, outDim: number, y: Float32Array = new Float32Array(seq * outDim), accumulate = false): Float32Array {
  for (let s = 0; s < seq; s++) {
    const xo = s * inDim;
    const yo = s * outDim;
    for (let o = 0; o < outDim; o++) {
      const wo = o * inDim;
      let acc = 0;
      for (let i = 0; i < inDim; i++) acc += x[xo + i] * w[wo + i];
      y[yo + o] = accumulate ? y[yo + o] + acc : acc;
    }
  }
  return y;
}

/** HF rotate_half RoPE applied in place to `buf[seq, nHeads*headDim]` at the given absolute positions. */
export function ropeInPlace(buf: Float32Array, seq: number, nHeads: number, headDim: number, positions: ArrayLike<number>, theta: number): void {
  const half = headDim / 2;
  const rowDim = nHeads * headDim;
  for (let s = 0; s < seq; s++) {
    const pos = positions[s];
    for (let i = 0; i < half; i++) {
      const freq = Math.pow(theta, -(2 * i) / headDim);
      const ang = pos * freq;
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      for (let h = 0; h < nHeads; h++) {
        const o = s * rowDim + h * headDim;
        const x1 = buf[o + i];
        const x2 = buf[o + i + half];
        buf[o + i] = x1 * c - x2 * sn;
        buf[o + i + half] = x2 * c + x1 * sn;
      }
    }
  }
}

export function silu(x: number): number {
  return x / (1 + Math.exp(-x));
}

/* ------------------------------------------------------------------ layer */

/**
 * One decoder layer over `seq` new tokens. Appends K/V to the cache, then attends causally over
 * the whole cache (previous tokens plus the new ones). `x` is updated in place (residual stream).
 */
export function layerForward(cfg: LlamaConfig, w: LayerWeights, x: Float32Array, seq: number, positions: ArrayLike<number>, kv: KvCache): void {
  const H = cfg.hidden;
  const headDim = cfg.headDim;
  const qDim = headDim * cfg.heads;
  const kvDim = headDim * cfg.kvHeads;
  const group = cfg.heads / cfg.kvHeads;
  if (kv.len + seq > kv.capacity) throw new Error("kv cache full");

  const h = rmsnorm(x, w.ln1, cfg.eps, seq, H);
  const q = matmulT(h, w.wq, seq, H, qDim);
  const k = matmulT(h, w.wk, seq, H, kvDim);
  const v = matmulT(h, w.wv, seq, H, kvDim);
  if (w.qNorm) rmsnorm(q, w.qNorm, cfg.eps, seq * cfg.heads, headDim, q);
  if (w.kNorm) rmsnorm(k, w.kNorm, cfg.eps, seq * cfg.kvHeads, headDim, k);
  ropeInPlace(q, seq, cfg.heads, headDim, positions, cfg.ropeTheta);
  ropeInPlace(k, seq, cfg.kvHeads, headDim, positions, cfg.ropeTheta);

  const base = kv.len;
  kv.k.set(k, base * kvDim);
  kv.v.set(v, base * kvDim);
  kv.len += seq;

  const scale = 1 / Math.sqrt(headDim);
  const attn = new Float32Array(seq * qDim);
  const scores = new Float32Array(kv.len);
  for (let s = 0; s < seq; s++) {
    const upto = base + s; // inclusive: causal
    for (let hd = 0; hd < cfg.heads; hd++) {
      const kvh = Math.floor(hd / group);
      const qo = s * qDim + hd * headDim;
      let max = -Infinity;
      for (let j = 0; j <= upto; j++) {
        const ko = j * kvDim + kvh * headDim;
        let dot = 0;
        for (let d = 0; d < headDim; d++) dot += q[qo + d] * kv.k[ko + d];
        const sc = dot * scale;
        scores[j] = sc;
        if (sc > max) max = sc;
      }
      let sum = 0;
      for (let j = 0; j <= upto; j++) {
        const e = Math.exp(scores[j] - max);
        scores[j] = e;
        sum += e;
      }
      const inv = 1 / sum;
      const ao = s * qDim + hd * headDim;
      for (let j = 0; j <= upto; j++) {
        const p = scores[j] * inv;
        const vo = j * kvDim + kvh * headDim;
        for (let d = 0; d < headDim; d++) attn[ao + d] += p * kv.v[vo + d];
      }
    }
  }
  matmulT(attn, w.wo, seq, qDim, H, x, true);

  const h2 = rmsnorm(x, w.ln2, cfg.eps, seq, H);
  const g = matmulT(h2, w.wgate, seq, H, cfg.intermediate);
  const u = matmulT(h2, w.wup, seq, H, cfg.intermediate);
  for (let i = 0; i < g.length; i++) g[i] = silu(g[i]) * u[i];
  matmulT(g, w.wdown, seq, cfg.intermediate, H, x, true);
}

export function stageForward(cfg: LlamaConfig, layers: LayerWeights[], kvs: KvCache[], x: Float32Array, seq: number, positions: ArrayLike<number>): void {
  for (let i = 0; i < layers.length; i++) layerForward(cfg, layers[i], x, seq, positions, kvs[i]);
}

/* ------------------------------------------------------------------ ends */

/** One dequantised row of a [rows, cols] weight entry. */
export function entryRow(e: WeightEntry, row: number, out: Float32Array = new Float32Array(e.shape[1])): Float32Array {
  const cols = e.shape[1];
  if (e.kind === "f32") {
    out.set(e.data.subarray(row * cols, (row + 1) * cols));
    return out;
  }
  const sc16 = new Uint16Array(e.scales.buffer);
  const nb = cols / QK;
  const b0 = row * nb;
  if (e.kind === "q8") {
    for (let b = 0; b < nb; b++) {
      const d = f16Bits(sc16[b0 + b]);
      const base = (b0 + b) * QK;
      for (let i = 0; i < QK; i++) {
        const q = e.qs[base + i];
        out[b * QK + i] = d * (q > 127 ? q - 256 : q);
      }
    }
  } else {
    for (let b = 0; b < nb; b++) {
      const d = f16Bits(sc16[b0 + b]);
      const base = (b0 + b) * 16;
      for (let i = 0; i < 16; i++) {
        const byte = e.qs[base + i];
        out[b * QK + i] = d * ((byte & 0xf) - 8);
        out[b * QK + i + 16] = d * ((byte >> 4) - 8);
      }
    }
  }
  return out;
}

export function embed(embedE: WeightEntry, hidden: number, tokens: ArrayLike<number>): Float32Array {
  const x = new Float32Array(tokens.length * hidden);
  for (let s = 0; s < tokens.length; s++) entryRow(embedE, tokens[s], x.subarray(s * hidden, (s + 1) * hidden));
  return x;
}

/** Final norm + (tied) output projection for one hidden row, streaming the head rows. */
export function finalLogits(cfg: LlamaConfig, normW: Float32Array, headE: WeightEntry, xRow: Float32Array, out: Float32Array = new Float32Array(cfg.vocab)): Float32Array {
  const h = rmsnorm(xRow, normW, cfg.eps, 1, cfg.hidden);
  const row = new Float32Array(cfg.hidden);
  for (let v = 0; v < cfg.vocab; v++) {
    entryRow(headE, v, row);
    let acc = 0;
    for (let i = 0; i < cfg.hidden; i++) acc += h[i] * row[i];
    out[v] = acc;
  }
  return out;
}

export interface TopK {
  ids: Int32Array;
  logits: Float32Array;
}

export function topK(logits: Float32Array, k: number): TopK {
  const ids = new Int32Array(k).fill(-1);
  const vals = new Float32Array(k).fill(-Infinity);
  for (let i = 0; i < logits.length; i++) {
    const v = logits[i];
    if (v <= vals[k - 1]) continue;
    let j = k - 1;
    while (j > 0 && vals[j - 1] < v) {
      vals[j] = vals[j - 1];
      ids[j] = ids[j - 1];
      j--;
    }
    vals[j] = v;
    ids[j] = i;
  }
  return { ids, logits: vals };
}

export interface SamplingOptions {
  temperature: number;
  topP: number;
  /** Deterministic PRNG state in [0, 2^32). */
  seed: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sample from a top-k list with temperature and nucleus truncation. temperature 0 = greedy. */
export function sampleTopK(tk: TopK, o: SamplingOptions, rnd: () => number): number {
  if (o.temperature <= 0) return tk.ids[0];
  const n = tk.ids.length;
  const p = new Float64Array(n);
  let max = -Infinity;
  for (let i = 0; i < n; i++) max = Math.max(max, tk.logits[i] / o.temperature);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    p[i] = Math.exp(tk.logits[i] / o.temperature - max);
    sum += p[i];
  }
  // Top-k list is sorted descending, so nucleus truncation is a prefix.
  let cum = 0;
  let cut = n;
  for (let i = 0; i < n; i++) {
    cum += p[i] / sum;
    if (cum >= o.topP) {
      cut = i + 1;
      break;
    }
  }
  let total = 0;
  for (let i = 0; i < cut; i++) total += p[i];
  let r = rnd() * total;
  for (let i = 0; i < cut; i++) {
    r -= p[i];
    if (r <= 0) return tk.ids[i];
  }
  return tk.ids[cut - 1];
}

/* ------------------------------------------------------------------ comparison */

/** Relative RMS distance between two activation tensors; the replica-verification metric. */
export function relativeRms(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Infinity;
  let num = 0;
  let den = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    num += d * d;
    den += a[i] * a[i];
  }
  if (den === 0) return num === 0 ? 0 : Infinity;
  return Math.sqrt(num / den);
}
