import type { LlamaConfig, NetworkModel, StageSpan } from "@/inference/config";
import { GGUF_EMBED, GGUF_FINAL_NORM, GGUF_OUTPUT, entryBytes, ggufLayerNames, type LoadedEntries, type WeightEntry } from "@/inference/gguf";
import { headColumns } from "@/inference/protocol";

/**
 * WebGPU execution of one pipeline stage of a Llama / Qwen3 decoder: a range of layers with a
 * per-session KV cache, plus the token embedding on stage 0 and the final norm + output projection
 * on the last stage. Weights stay quantised on the GPU (Q4_0 / Q8_0 blocks, f16 scales) and are
 * dequantised in registers inside the matrix-vector kernels; activations are f32; the KV cache is
 * f16. Every kernel has its CPU twin in inference/llama.ts and the two agree to ~1e-4 relative RMS
 * on real weights (the f16 cache is the largest source of difference).
 *
 * Kernel design (cooperative rows, dequantise in registers, f16 scales two per word) follows
 * Nehanth/pooled (MIT); see NOTICE.
 */

const RMSNORM = /* wgsl */ `
struct P { rows: u32, dim: u32, pad0: u32, pad1: u32, eps: f32, pad2: f32, pad3: f32, pad4: f32 };
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> partial: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let row = wg.x;
  let o = row * p.dim;
  var ss: f32 = 0.0;
  for (var i: u32 = lid.x; i < p.dim; i = i + 256u) { let v = x[o + i]; ss = ss + v * v; }
  partial[lid.x] = ss;
  workgroupBarrier();
  for (var s: u32 = 128u; s > 0u; s = s >> 1u) {
    if (lid.x < s) { partial[lid.x] = partial[lid.x] + partial[lid.x + s]; }
    workgroupBarrier();
  }
  let inv = 1.0 / sqrt(partial[0] / f32(p.dim) + p.eps);
  for (var i: u32 = lid.x; i < p.dim; i = i + 256u) { y[o + i] = (x[o + i] * inv) * w[i]; }
}
`;

/** f32 weights [out, in]: one thread per (row, column). Only norms are f32 now; kept as the fallback. */
const MATMUL_F32 = /* wgsl */ `
struct P { seq: u32, inDim: u32, outDim: u32, accumulate: u32 };
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let o = g.x;
  let s = g.y;
  if (o >= p.outDim || s >= p.seq) { return; }
  let xo = s * p.inDim;
  let wo = o * p.inDim;
  var acc: f32 = 0.0;
  for (var i: u32 = 0u; i < p.inDim; i = i + 1u) { acc = acc + x[xo + i] * w[wo + i]; }
  let idx = s * p.outDim + o;
  if (p.accumulate == 1u) { y[idx] = y[idx] + acc; } else { y[idx] = acc; }
}
`;

/**
 * Quantised GEMV: a workgroup of 64 threads computes 4 output rows for one activation column.
 * Thread t sweeps blocks t, t+64, ... of each row (consecutive threads read consecutive 16- or
 * 32-byte blocks: coalesced), dequantises in registers and reduces through shared memory.
 * y[col, row] (+)= dot(x[col], W[row]).
 */
const matvecQuant = (kind: "q4" | "q8") => /* wgsl */ `
struct P { seq: u32, inDim: u32, outDim: u32, accumulate: u32 };
@group(0) @binding(0) var<storage, read> x: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> qs: array<u32>;
@group(0) @binding(2) var<storage, read> sc: array<u32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
var<workgroup> part: array<f32, 256>;

fn i8x4(w: u32) -> vec4<f32> {
  return vec4<f32>(f32(i32(w << 24u) >> 24u), f32(i32(w << 16u) >> 24u), f32(i32(w << 8u) >> 24u), f32(i32(w) >> 24u));
}
fn lo4(w: u32) -> vec4<f32> {
  return vec4<f32>(f32(w & 0xFu), f32((w >> 8u) & 0xFu), f32((w >> 16u) & 0xFu), f32((w >> 24u) & 0xFu)) - vec4<f32>(8.0);
}
fn hi4(w: u32) -> vec4<f32> {
  return vec4<f32>(f32((w >> 4u) & 0xFu), f32((w >> 12u) & 0xFu), f32((w >> 20u) & 0xFu), f32((w >> 28u) & 0xFu)) - vec4<f32>(8.0);
}

// Dot product of one 32-element block (index bi) with the 8 vec4 of activations.
fn blockDot(bi: u32, x0: vec4<f32>, x1: vec4<f32>, x2: vec4<f32>, x3: vec4<f32>, x4: vec4<f32>, x5: vec4<f32>, x6: vec4<f32>, x7: vec4<f32>) -> f32 {
  let s = unpack2x16float(sc[bi >> 1u])[bi & 1u];
${
  kind === "q4"
    ? `  let w0 = qs[bi * 4u]; let w1 = qs[bi * 4u + 1u]; let w2 = qs[bi * 4u + 2u]; let w3 = qs[bi * 4u + 3u];
  // low nibbles are elements 0..15, high nibbles 16..31
  let d = dot(lo4(w0), x0) + dot(lo4(w1), x1) + dot(lo4(w2), x2) + dot(lo4(w3), x3)
        + dot(hi4(w0), x4) + dot(hi4(w1), x5) + dot(hi4(w2), x6) + dot(hi4(w3), x7);`
    : `  let b = bi * 8u;
  let d = dot(i8x4(qs[b]), x0) + dot(i8x4(qs[b + 1u]), x1) + dot(i8x4(qs[b + 2u]), x2) + dot(i8x4(qs[b + 3u]), x3)
        + dot(i8x4(qs[b + 4u]), x4) + dot(i8x4(qs[b + 5u]), x5) + dot(i8x4(qs[b + 6u]), x6) + dot(i8x4(qs[b + 7u]), x7);`
}
  return s * d;
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let t = lid.x;
  let row0 = wg.x * 4u;
  let col = wg.y;
  let nb = p.inDim / 32u;
  let xo = col * (p.inDim / 4u);
  let r1 = row0 + 1u < p.outDim;
  let r2 = row0 + 2u < p.outDim;
  let r3 = row0 + 3u < p.outDim;
  var acc0 = 0.0; var acc1 = 0.0; var acc2 = 0.0; var acc3 = 0.0;
  for (var b: u32 = t; b < nb; b = b + 64u) {
    let xb = xo + b * 8u;
    let x0 = x[xb]; let x1 = x[xb + 1u]; let x2 = x[xb + 2u]; let x3 = x[xb + 3u];
    let x4 = x[xb + 4u]; let x5 = x[xb + 5u]; let x6 = x[xb + 6u]; let x7 = x[xb + 7u];
    acc0 = acc0 + blockDot(row0 * nb + b, x0, x1, x2, x3, x4, x5, x6, x7);
    if (r1) { acc1 = acc1 + blockDot((row0 + 1u) * nb + b, x0, x1, x2, x3, x4, x5, x6, x7); }
    if (r2) { acc2 = acc2 + blockDot((row0 + 2u) * nb + b, x0, x1, x2, x3, x4, x5, x6, x7); }
    if (r3) { acc3 = acc3 + blockDot((row0 + 3u) * nb + b, x0, x1, x2, x3, x4, x5, x6, x7); }
  }
  part[t] = acc0; part[64u + t] = acc1; part[128u + t] = acc2; part[192u + t] = acc3;
  workgroupBarrier();
  for (var s: u32 = 32u; s > 0u; s = s >> 1u) {
    if (t < s) {
      part[t] = part[t] + part[t + s];
      part[64u + t] = part[64u + t] + part[64u + t + s];
      part[128u + t] = part[128u + t] + part[128u + t + s];
      part[192u + t] = part[192u + t] + part[192u + t + s];
    }
    workgroupBarrier();
  }
  if (t < 4u) {
    let row = row0 + t;
    if (row < p.outDim) {
      let idx = col * p.outDim + row;
      let v = part[t * 64u];
      if (p.accumulate == 1u) { y[idx] = y[idx] + v; } else { y[idx] = v; }
    }
  }
}
`;

/** Token embedding lookup from a quantised table: one thread per (column, element). */
const EMBED = /* wgsl */ `
struct P { seq: u32, hidden: u32, kind: u32, pad: u32 };
@group(0) @binding(0) var<storage, read> tokens: array<u32>;
@group(0) @binding(1) var<storage, read> qs: array<u32>;
@group(0) @binding(2) var<storage, read> sc: array<u32>;
@group(0) @binding(3) var<storage, read_write> x: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  let col = g.y;
  if (i >= p.hidden || col >= p.seq) { return; }
  let e = tokens[col] * p.hidden + i;
  let bi = e / 32u;
  let k = e % 32u;
  let s = unpack2x16float(sc[bi >> 1u])[bi & 1u];
  var v: f32;
  if (p.kind == 0u) {
    let w = qs[bi * 8u + k / 4u];
    v = f32(i32(w << (24u - 8u * (k % 4u))) >> 24u);
  } else {
    let kk = k % 16u;
    let w = qs[bi * 4u + kk / 4u];
    let shift = 8u * (kk % 4u) + select(0u, 4u, k >= 16u);
    v = f32((w >> shift) & 0xFu) - 8.0;
  }
  x[col * p.hidden + i] = s * v;
}
`;

const ROPE = /* wgsl */ `
struct P { seq: u32, heads: u32, headDim: u32, pad: u32, theta: f32, pad1: f32, pad2: f32, pad3: f32 };
@group(0) @binding(0) var<storage, read_write> b: array<f32>;
@group(0) @binding(1) var<storage, read> pos: array<u32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let half = p.headDim / 2u;
  let i = g.x;
  let h = g.y;
  let s = g.z;
  if (i >= half || h >= p.heads || s >= p.seq) { return; }
  let freq = pow(p.theta, -f32(2u * i) / f32(p.headDim));
  let ang = f32(pos[s]) * freq;
  let c = cos(ang);
  let sn = sin(ang);
  let o = s * p.heads * p.headDim + h * p.headDim;
  let x1 = b[o + i];
  let x2 = b[o + i + half];
  b[o + i] = x1 * c - x2 * sn;
  b[o + i + half] = x2 * c + x1 * sn;
}
`;

/** Append f32 k/v rows to the f16 cache at positions base..base+seq. One thread per packed word. */
const KV_STORE = /* wgsl */ `
struct P { seq: u32, base: u32, kvDim: u32, pad: u32 };
@group(0) @binding(0) var<storage, read> k: array<f32>;
@group(0) @binding(1) var<storage, read> v: array<f32>;
@group(0) @binding(2) var<storage, read_write> kc: array<u32>;
@group(0) @binding(3) var<storage, read_write> vc: array<u32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  let words = p.seq * p.kvDim / 2u;
  if (i >= words) { return; }
  let dst = p.base * p.kvDim / 2u + i;
  kc[dst] = pack2x16float(vec2<f32>(k[2u * i], k[2u * i + 1u]));
  vc[dst] = pack2x16float(vec2<f32>(v[2u * i], v[2u * i + 1u]));
}
`;

/** One thread per (row, head); online softmax over the f16 cache so no score buffer is needed. */
const ATTENTION = /* wgsl */ `
struct P { seq: u32, base: u32, heads: u32, kvHeads: u32, headDim: u32, kvDim: u32, qDim: u32, pad: u32, scale: f32, pad1: f32, pad2: f32, pad3: f32 };
@group(0) @binding(0) var<storage, read> q: array<f32>;
@group(0) @binding(1) var<storage, read> kc: array<u32>;
@group(0) @binding(2) var<storage, read> vc: array<u32>;
@group(0) @binding(3) var<storage, read_write> out: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let h = g.x;
  let s = g.y;
  if (h >= p.heads || s >= p.seq) { return; }
  let group = p.heads / p.kvHeads;
  let kvh = h / group;
  let qo = s * p.qDim + h * p.headDim;
  let upto = p.base + s;
  let hw = p.headDim / 2u;
  var m: f32 = -3.0e38;
  var l: f32 = 0.0;
  var acc: array<f32, 128>;
  for (var d: u32 = 0u; d < p.headDim; d = d + 1u) { acc[d] = 0.0; }
  for (var j: u32 = 0u; j <= upto; j = j + 1u) {
    let ko = (j * p.kvDim + kvh * p.headDim) / 2u;
    var dot: f32 = 0.0;
    for (var d: u32 = 0u; d < hw; d = d + 1u) {
      let kk = unpack2x16float(kc[ko + d]);
      dot = dot + q[qo + 2u * d] * kk.x + q[qo + 2u * d + 1u] * kk.y;
    }
    let sc = dot * p.scale;
    let mn = max(m, sc);
    let corr = exp(m - mn);
    let w = exp(sc - mn);
    l = l * corr + w;
    for (var d: u32 = 0u; d < hw; d = d + 1u) {
      let vv = unpack2x16float(vc[ko + d]);
      acc[2u * d] = acc[2u * d] * corr + w * vv.x;
      acc[2u * d + 1u] = acc[2u * d + 1u] * corr + w * vv.y;
    }
    m = mn;
  }
  let oo = s * p.qDim + h * p.headDim;
  for (var d: u32 = 0u; d < p.headDim; d = d + 1u) { out[oo + d] = acc[d] / l; }
}
`;

const SILU_MUL = /* wgsl */ `
struct P { n: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<storage, read_write> g: array<f32>;
@group(0) @binding(1) var<storage, read> u: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n) { return; }
  let x = g[i];
  g[i] = (x / (1.0 + exp(-x))) * u[i];
}
`;

type GpuWeight = { kind: "f32"; buf: GPUBuffer; rows: number; cols: number } | { kind: "q4" | "q8"; buf: GPUBuffer; scales: GPUBuffer; rows: number; cols: number };

interface GpuLayer {
  ln1: GPUBuffer;
  wq: GpuWeight;
  wk: GpuWeight;
  wv: GpuWeight;
  wo: GpuWeight;
  qNorm?: GPUBuffer;
  kNorm?: GPUBuffer;
  ln2: GPUBuffer;
  wgate: GpuWeight;
  wup: GpuWeight;
  wdown: GpuWeight;
}

interface Session {
  k: GPUBuffer[];
  v: GPUBuffer[];
  len: number;
  lastUsed: number;
}

export interface StageInput {
  /** Stage 0: token ids. */
  tokens?: Uint32Array;
  /** Other stages: [seq, hidden] f32. */
  hidden?: Float32Array;
}

export interface StageForwardResult {
  /** [seq, hidden] f32 (stages without the head). */
  hidden?: Float32Array;
  /** [headColumns(seq), vocab] f32 for the last positions of the lap (the head stage). */
  logits?: Float32Array;
  gpuMs: number;
  /** Cache length after this call. */
  cacheLen: number;
}

export class LlmStage {
  private pipelines = new Map<string, GPUComputePipeline>();
  private layers: GpuLayer[] = [];
  private sessions = new Map<string, Session>();
  private embedW?: GpuWeight;
  private finalNorm?: GPUBuffer;
  private headW?: GpuWeight;
  readonly weightBytes: number;

  private constructor(
    private device: GPUDevice,
    readonly model: NetworkModel,
    readonly span: StageSpan,
    weightBytes: number,
  ) {
    this.weightBytes = weightBytes;
  }

  get cfg(): LlamaConfig {
    return this.model.config;
  }

  static async create(model: NetworkModel, span: StageSpan, entries: LoadedEntries, device?: GPUDevice): Promise<LlmStage> {
    const dev = device ?? (await requestDevice());
    const stage = new LlmStage(dev, model, span, 0);
    for (const k of ["rmsnorm", "matmul_f32", "matvec_q4", "matvec_q8", "embed", "rope", "kv_store", "attention", "silu"]) stage.pipeline(k);
    let bytes = 0;
    const storage = (data: ArrayBufferView) => {
      bytes += data.byteLength;
      const buf = dev.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(buf, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
      return buf;
    };
    const weight = (e: WeightEntry): GpuWeight => {
      if (e.shape.length !== 2) throw new Error("matrix expected");
      const [rows, cols] = e.shape;
      if (e.kind === "f32") return { kind: "f32", buf: storage(e.data), rows, cols };
      if (cols % 32 !== 0) throw new Error(`cols ${cols} not a multiple of 32`);
      return { kind: e.kind, buf: storage(e.qs), scales: storage(e.scales), rows, cols };
    };
    const vector = (e: WeightEntry): GPUBuffer => {
      if (e.kind !== "f32") throw new Error("f32 vector expected");
      return storage(e.data);
    };
    for (let l = span.layerFrom; l < span.layerTo; l++) {
      const n = ggufLayerNames(l);
      stage.layers.push({
        ln1: vector(entries.get(n.ln1)),
        wq: weight(entries.get(n.wq)),
        wk: weight(entries.get(n.wk)),
        wv: weight(entries.get(n.wv)),
        wo: weight(entries.get(n.wo)),
        qNorm: entries.has(n.qNorm) ? vector(entries.get(n.qNorm)) : undefined,
        kNorm: entries.has(n.kNorm) ? vector(entries.get(n.kNorm)) : undefined,
        ln2: vector(entries.get(n.ln2)),
        wgate: weight(entries.get(n.wgate)),
        wup: weight(entries.get(n.wup)),
        wdown: weight(entries.get(n.wdown)),
      });
    }
    if (span.hasEmbed || span.hasHead) {
      const embedE = entries.get(GGUF_EMBED);
      if (embedE.kind === "f32") throw new Error("embedding must be quantised (q4/q8) for the GPU");
      const embedW = weight(embedE);
      if (span.hasEmbed) stage.embedW = embedW;
      if (span.hasHead) {
        stage.finalNorm = vector(entries.get(GGUF_FINAL_NORM));
        stage.headW = entries.has(GGUF_OUTPUT) ? weight(entries.get(GGUF_OUTPUT)) : embedW;
      }
    }
    (stage as { weightBytes: number }).weightBytes = bytes;
    await dev.queue.onSubmittedWorkDone();
    return stage;
  }

  /** Bytes the entries for a span occupy on the GPU (what `create` will upload). */
  static gpuBytes(entries: LoadedEntries, names: string[]): number {
    return names.reduce((a, n) => (entries.has(n) ? a + entryBytes(entries.get(n)) : a), 0);
  }

  private pipeline(name: string): GPUComputePipeline {
    let p = this.pipelines.get(name);
    if (!p) {
      const code =
        name === "rmsnorm" ? RMSNORM
        : name === "matmul_f32" ? MATMUL_F32
        : name === "matvec_q4" ? matvecQuant("q4")
        : name === "matvec_q8" ? matvecQuant("q8")
        : name === "embed" ? EMBED
        : name === "rope" ? ROPE
        : name === "kv_store" ? KV_STORE
        : name === "attention" ? ATTENTION
        : SILU_MUL;
      const module = this.device.createShaderModule({ code });
      p = this.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
      this.pipelines.set(name, p);
    }
    return p;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  cacheLen(id: string): number {
    return this.sessions.get(id)?.len ?? 0;
  }

  private session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      const kvDim = this.cfg.headDim * this.cfg.kvHeads;
      const bytes = this.model.maxContext * kvDim * 2; // f16
      const mk = () => this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      s = { k: this.layers.map(mk), v: this.layers.map(mk), len: 0, lastUsed: Date.now() };
      this.sessions.set(id, s);
    }
    s.lastUsed = Date.now();
    return s;
  }

  dropSession(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.k.forEach((b) => b.destroy());
    s.v.forEach((b) => b.destroy());
    this.sessions.delete(id);
  }

  /** Free sessions idle longer than `ms`. Returns how many were dropped. */
  sweep(ms: number): number {
    const now = Date.now();
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (now - s.lastUsed > ms) {
        this.dropSession(id);
        n++;
      }
    }
    return n;
  }

  /**
   * Run this stage over `seq` new tokens at absolute `positions`, appending to the session's cache.
   * `expectCacheLen` is the cache length the hop assumes: a longer cache is truncated to it (the
   * rollback after rejected speculative drafts); a shorter one means a hop was missed and the call
   * fails with `cache_mismatch:<len>`.
   */
  async forward(sessionId: string, input: StageInput, seq: number, positions: number[], expectCacheLen: number): Promise<StageForwardResult> {
    const c = this.cfg;
    const H = c.hidden;
    const headDim = c.headDim;
    const qDim = headDim * c.heads;
    const kvDim = headDim * c.kvHeads;
    const I = c.intermediate;
    if (positions.length !== seq) throw new Error("positions length mismatch");
    const sess = this.session(sessionId);
    if (sess.len > expectCacheLen) sess.len = expectCacheLen;
    if (sess.len !== expectCacheLen) throw new Error(`cache_mismatch:${sess.len}`);
    if (sess.len + seq > this.model.maxContext) throw new Error("context_full");
    const base = sess.len;

    const dev = this.device;
    const temps: GPUBuffer[] = [];
    const f32 = (n: number) => {
      const b = dev.createBuffer({ size: Math.max(16, n * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      temps.push(b);
      return b;
    };
    const x = f32(seq * H);
    if (this.span.hasEmbed) {
      if (!input.tokens || input.tokens.length !== seq) throw new Error("tokens expected");
    } else {
      if (!input.hidden || input.hidden.length !== seq * H) throw new Error("hidden shape mismatch");
      dev.queue.writeBuffer(x, 0, input.hidden.buffer as ArrayBuffer, input.hidden.byteOffset, input.hidden.byteLength);
    }
    const h = f32(seq * H);
    const q0 = f32(seq * qDim);
    const k0 = f32(seq * kvDim);
    const v = f32(seq * kvDim);
    // q/k norm cannot run in place (a buffer may not be bound read-only and read-write at once).
    const q1 = c.qkNorm ? f32(seq * qDim) : q0;
    const k1 = c.qkNorm ? f32(seq * kvDim) : k0;
    const attn = f32(seq * qDim);
    const g = f32(seq * I);
    const u = f32(seq * I);
    const pos = dev.createBuffer({ size: Math.max(16, seq * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(pos, 0, new Uint32Array(positions));
    temps.push(pos);

    const uniform = (words: (number | ["f", number])[]) => {
      const buf = dev.createBuffer({ size: Math.max(16, Math.ceil((words.length * 4) / 16) * 16), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const ab = new ArrayBuffer(buf.size);
      const dv = new DataView(ab);
      words.forEach((w, i) => (Array.isArray(w) ? dv.setFloat32(i * 4, w[1], true) : dv.setUint32(i * 4, w >>> 0, true)));
      dev.queue.writeBuffer(buf, 0, ab);
      temps.push(buf);
      return buf;
    };

    const enc = dev.createCommandEncoder();
    const dispatch = (name: string, buffers: GPUBuffer[], wg: [number, number, number]) => {
      const pipeline = this.pipeline(name);
      const bg = dev.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(wg[0], wg[1], wg[2]);
      pass.end();
    };
    const rms = (input: GPUBuffer, w: GPUBuffer, out: GPUBuffer, rows: number, dim: number) => dispatch("rmsnorm", [input, w, out, uniform([rows, dim, 0, 0, ["f", c.eps], 0, 0, 0])], [rows, 1, 1]);
    const mm = (input: GPUBuffer, w: GpuWeight, out: GPUBuffer, accumulate = false) => {
      const params = uniform([seq, w.cols, w.rows, accumulate ? 1 : 0]);
      if (w.kind === "f32") dispatch("matmul_f32", [input, w.buf, out, params], [Math.ceil(w.rows / 64), seq, 1]);
      else dispatch(`matvec_${w.kind}`, [input, w.buf, w.scales, out, params], [Math.ceil(w.rows / 4), seq, 1]);
    };
    const rope = (buf: GPUBuffer, heads: number) => dispatch("rope", [buf, pos, uniform([seq, heads, headDim, 0, ["f", c.ropeTheta], 0, 0, 0])], [Math.ceil(headDim / 2 / 64), heads, seq]);

    if (this.span.hasEmbed) {
      const tok = dev.createBuffer({ size: Math.max(16, seq * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(tok, 0, input.tokens!.buffer as ArrayBuffer, input.tokens!.byteOffset, input.tokens!.byteLength);
      temps.push(tok);
      const e = this.embedW!;
      if (e.kind === "f32") throw new Error("f32 embedding unsupported");
      dispatch("embed", [tok, e.buf, e.scales, x, uniform([seq, H, e.kind === "q8" ? 0 : 1, 0])], [Math.ceil(H / 256), seq, 1]);
    }

    for (let li = 0; li < this.layers.length; li++) {
      const L = this.layers[li];
      rms(x, L.ln1, h, seq, H);
      mm(h, L.wq, q0);
      mm(h, L.wk, k0);
      mm(h, L.wv, v);
      let q = q0;
      let k = k0;
      if (L.qNorm) {
        rms(q0, L.qNorm, q1, seq * c.heads, headDim);
        q = q1;
      }
      if (L.kNorm) {
        rms(k0, L.kNorm, k1, seq * c.kvHeads, headDim);
        k = k1;
      }
      rope(q, c.heads);
      rope(k, c.kvHeads);
      dispatch("kv_store", [k, v, sess.k[li], sess.v[li], uniform([seq, base, kvDim, 0])], [Math.ceil((seq * kvDim) / 2 / 256), 1, 1]);
      dispatch(
        "attention",
        [q, sess.k[li], sess.v[li], attn, uniform([seq, base, c.heads, c.kvHeads, headDim, kvDim, qDim, 0, ["f", 1 / Math.sqrt(headDim)], 0, 0, 0])],
        [Math.ceil(c.heads / 32), seq, 1],
      );
      mm(attn, L.wo, x, true);
      rms(x, L.ln2, h, seq, H);
      mm(h, L.wgate, g);
      mm(h, L.wup, u);
      dispatch("silu", [g, u, uniform([seq * I, 0, 0, 0])], [Math.ceil((seq * I) / 256), 1, 1]);
      mm(g, L.wdown, x, true);
    }

    let outBuf = x;
    let outCount = seq * H;
    if (this.span.hasHead) {
      // Only the last headColumns(seq) positions are projected: a prefill needs its final column
      // only, and a 512-token prefill would otherwise mean a 300 MB logits buffer and readback.
      const n = headColumns(seq);
      let tail = x;
      if (n < seq) {
        tail = f32(n * H);
        enc.copyBufferToBuffer(x, (seq - n) * H * 4, tail, 0, n * H * 4);
      }
      const normed = f32(n * H);
      rms(tail, this.finalNorm!, normed, n, H);
      const logits = f32(n * c.vocab);
      mm(normed, this.headW!, logits);
      outBuf = logits;
      outCount = n * c.vocab;
    }

    const outBytes = outCount * 4;
    const readback = dev.createBuffer({ size: outBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyBufferToBuffer(outBuf, 0, readback, 0, outBytes);
    const t0 = performance.now();
    dev.queue.submit([enc.finish()]);
    await dev.queue.onSubmittedWorkDone();
    const gpuMs = performance.now() - t0;
    await readback.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    readback.destroy();
    temps.forEach((b) => b.destroy());
    sess.len += seq;
    return this.span.hasHead ? { logits: out, gpuMs, cacheLen: sess.len } : { hidden: out, gpuMs, cacheLen: sess.len };
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.dropSession(id);
    const seen = new Set<GPUBuffer>();
    const kill = (b?: GPUBuffer) => {
      if (b && !seen.has(b)) {
        seen.add(b);
        b.destroy();
      }
    };
    for (const L of this.layers) {
      for (const w of [L.wq, L.wk, L.wv, L.wo, L.wgate, L.wup, L.wdown]) {
        kill(w.buf);
        if (w.kind !== "f32") kill(w.scales);
      }
      kill(L.ln1);
      kill(L.ln2);
      kill(L.qNorm);
      kill(L.kNorm);
    }
    for (const w of [this.embedW, this.headW]) {
      if (!w) continue;
      kill(w.buf);
      if (w.kind !== "f32") kill(w.scales);
    }
    kill(this.finalNorm);
    this.layers = [];
  }
}

/** Largest buffer we will ask for: the Q8 embedding of the 4B (≈413 MB) plus headroom. */
const WANT_BUFFER_BYTES = 1024 * 1024 * 1024;

export async function requestDevice(): Promise<GPUDevice> {
  if (!navigator.gpu) throw new Error("WebGPU unavailable");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No GPU adapter");
  return adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, WANT_BUFFER_BYTES),
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, WANT_BUFFER_BYTES),
    },
  });
}
