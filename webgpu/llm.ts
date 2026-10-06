import type { LlamaConfig, NetworkModel, StageSpan } from "@/inference/config";
import { layerTensorNames, type LoadedTensors } from "@/inference/safetensors";

/**
 * WebGPU execution of a range of Llama decoder layers (one pipeline stage) with a per-session
 * KV cache. f32 throughout; every kernel has its CPU twin in inference/llama.ts, and the two are
 * expected to agree to ~1e-5 relative RMS.
 */

const RMSNORM = /* wgsl */ `
struct P { seq: u32, dim: u32, pad0: u32, pad1: u32, eps: f32, pad2: f32, pad3: f32, pad4: f32 };
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

const MATMUL_T = /* wgsl */ `
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

const ROPE = /* wgsl */ `
struct P { seq: u32, heads: u32, headDim: u32, pad: u32, theta: f32, pad1: f32, pad2: f32, pad3: f32 };
@group(0) @binding(0) var<storage, read_write> b: array<f32>;
@group(0) @binding(1) var<storage, read> pos: array<u32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let half = p.headDim / 2u;
  let i = g.x;            // 0..half
  let h = g.y;            // head
  let s = g.z;            // row
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

/** One thread per (row, head); online softmax over the cache so no score buffer is needed. */
const ATTENTION = /* wgsl */ `
struct P { seq: u32, base: u32, heads: u32, kvHeads: u32, headDim: u32, kvDim: u32, hidden: u32, pad: u32, scale: f32, pad1: f32, pad2: f32, pad3: f32 };
@group(0) @binding(0) var<storage, read> q: array<f32>;
@group(0) @binding(1) var<storage, read> kc: array<f32>;
@group(0) @binding(2) var<storage, read> vc: array<f32>;
@group(0) @binding(3) var<storage, read_write> out: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let h = g.x;
  let s = g.y;
  if (h >= p.heads || s >= p.seq) { return; }
  let group = p.heads / p.kvHeads;
  let kvh = h / group;
  let qo = s * p.hidden + h * p.headDim;
  let upto = p.base + s;
  var m: f32 = -3.0e38;
  var l: f32 = 0.0;
  var acc: array<f32, 128>;
  for (var d: u32 = 0u; d < p.headDim; d = d + 1u) { acc[d] = 0.0; }
  for (var j: u32 = 0u; j <= upto; j = j + 1u) {
    let ko = j * p.kvDim + kvh * p.headDim;
    var dot: f32 = 0.0;
    for (var d: u32 = 0u; d < p.headDim; d = d + 1u) { dot = dot + q[qo + d] * kc[ko + d]; }
    let sc = dot * p.scale;
    let mn = max(m, sc);
    let corr = exp(m - mn);
    let w = exp(sc - mn);
    l = l * corr + w;
    for (var d: u32 = 0u; d < p.headDim; d = d + 1u) { acc[d] = acc[d] * corr + w * vc[ko + d]; }
    m = mn;
  }
  let oo = s * p.hidden + h * p.headDim;
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

interface GpuLayer {
  ln1: GPUBuffer;
  wq: GPUBuffer;
  wk: GPUBuffer;
  wv: GPUBuffer;
  wo: GPUBuffer;
  ln2: GPUBuffer;
  wgate: GPUBuffer;
  wup: GPUBuffer;
  wdown: GPUBuffer;
}

interface Session {
  k: GPUBuffer[];
  v: GPUBuffer[];
  len: number;
  lastUsed: number;
}

export interface StageForwardResult {
  hidden: Float32Array;
  gpuMs: number;
  /** Cache length after this call. */
  cacheLen: number;
}

export class LlmStage {
  private pipelines = new Map<string, GPUComputePipeline>();
  private layers: GpuLayer[] = [];
  private sessions = new Map<string, Session>();
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

  static async create(model: NetworkModel, span: StageSpan, tensors: LoadedTensors, device?: GPUDevice): Promise<LlmStage> {
    const dev = device ?? (await requestDevice());
    const stage = new LlmStage(dev, model, span, 0);
    for (const k of ["rmsnorm", "matmul", "rope", "attention", "silu"]) stage.pipeline(k);
    let bytes = 0;
    const up = (name: string) => {
      const data = tensors.get(name);
      bytes += data.byteLength;
      const buf = dev.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(buf, 0, data as Float32Array<ArrayBuffer>);
      return buf;
    };
    for (let l = span.layerFrom; l < span.layerTo; l++) {
      const [ln1, wq, wk, wv, wo, ln2, wgate, wup, wdown] = layerTensorNames(l).map(up);
      stage.layers.push({ ln1, wq, wk, wv, wo, ln2, wgate, wup, wdown });
    }
    (stage as { weightBytes: number }).weightBytes = bytes;
    await dev.queue.onSubmittedWorkDone();
    return stage;
  }

  private pipeline(name: string): GPUComputePipeline {
    let p = this.pipelines.get(name);
    if (!p) {
      const code = name === "rmsnorm" ? RMSNORM : name === "matmul" ? MATMUL_T : name === "rope" ? ROPE : name === "attention" ? ATTENTION : SILU_MUL;
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
      const kvDim = (this.cfg.hidden / this.cfg.heads) * this.cfg.kvHeads;
      const bytes = this.model.maxContext * kvDim * 4;
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
   * Run this stage's layers over `seq` new tokens of `hidden` ([seq, hidden] f32) at absolute
   * `positions`, appending to the session's cache. `expectCacheLen` guards against a hop arriving
   * out of order: if the cache does not have exactly that many positions the call fails.
   */
  async forward(sessionId: string, hidden: Float32Array, seq: number, positions: number[], expectCacheLen: number): Promise<StageForwardResult> {
    const c = this.cfg;
    const H = c.hidden;
    const headDim = H / c.heads;
    const kvDim = headDim * c.kvHeads;
    const I = c.intermediate;
    if (hidden.length !== seq * H) throw new Error("hidden shape mismatch");
    if (positions.length !== seq) throw new Error("positions length mismatch");
    const sess = this.session(sessionId);
    if (sess.len !== expectCacheLen) throw new Error(`cache_mismatch:${sess.len}`);
    if (sess.len + seq > this.model.maxContext) throw new Error("context_full");
    const base = sess.len;

    const dev = this.device;
    const f32 = (n: number, extra = 0) => dev.createBuffer({ size: Math.max(16, n * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | extra });
    const x = f32(seq * H);
    dev.queue.writeBuffer(x, 0, hidden as Float32Array<ArrayBuffer>);
    const h = f32(seq * H);
    const q = f32(seq * H);
    const k = f32(seq * kvDim);
    const v = f32(seq * kvDim);
    const attn = f32(seq * H);
    const g = f32(seq * I);
    const u = f32(seq * I);
    const pos = dev.createBuffer({ size: Math.max(16, seq * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(pos, 0, new Uint32Array(positions));
    const temps: GPUBuffer[] = [x, h, q, k, v, attn, g, u, pos];

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
    const rms = (input: GPUBuffer, w: GPUBuffer, out: GPUBuffer) => dispatch("rmsnorm", [input, w, out, uniform([seq, H, 0, 0, ["f", c.eps], 0, 0, 0])], [seq, 1, 1]);
    const mm = (input: GPUBuffer, w: GPUBuffer, out: GPUBuffer, inDim: number, outDim: number, accumulate = false) =>
      dispatch("matmul", [input, w, out, uniform([seq, inDim, outDim, accumulate ? 1 : 0])], [Math.ceil(outDim / 64), seq, 1]);
    const rope = (buf: GPUBuffer, heads: number) => dispatch("rope", [buf, pos, uniform([seq, heads, headDim, 0, ["f", c.ropeTheta], 0, 0, 0])], [Math.ceil(headDim / 2 / 64), heads, seq]);

    for (let li = 0; li < this.layers.length; li++) {
      const L = this.layers[li];
      rms(x, L.ln1, h);
      mm(h, L.wq, q, H, H);
      mm(h, L.wk, k, H, kvDim);
      mm(h, L.wv, v, H, kvDim);
      rope(q, c.heads);
      rope(k, c.kvHeads);
      enc.copyBufferToBuffer(k, 0, sess.k[li], base * kvDim * 4, seq * kvDim * 4);
      enc.copyBufferToBuffer(v, 0, sess.v[li], base * kvDim * 4, seq * kvDim * 4);
      dispatch(
        "attention",
        [q, sess.k[li], sess.v[li], attn, uniform([seq, base, c.heads, c.kvHeads, headDim, kvDim, H, 0, ["f", 1 / Math.sqrt(headDim)], 0, 0, 0])],
        [Math.ceil(c.heads / 32), seq, 1],
      );
      mm(attn, L.wo, x, H, H, true);
      rms(x, L.ln2, h);
      mm(h, L.wgate, g, H, I);
      mm(h, L.wup, u, H, I);
      dispatch("silu", [g, u, uniform([seq * I, 0, 0, 0])], [Math.ceil((seq * I) / 256), 1, 1]);
      mm(g, L.wdown, x, I, H, true);
    }

    const outBytes = seq * H * 4;
    const readback = dev.createBuffer({ size: outBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyBufferToBuffer(x, 0, readback, 0, outBytes);
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
    return { hidden: out, gpuMs, cacheLen: sess.len };
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.dropSession(id);
    for (const L of this.layers) Object.values(L).forEach((b) => b.destroy());
    this.layers = [];
  }
}

export async function requestDevice(): Promise<GPUDevice> {
  if (!navigator.gpu) throw new Error("WebGPU unavailable");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No GPU adapter");
  return adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 256 * 1024 * 1024),
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, 256 * 1024 * 1024),
    },
  });
}
