/**
 * Minimal safetensors reader with HTTP range support. A node fetches the file header once, then
 * only the byte spans for the tensors its pipeline stage needs. Works in the browser and in Node.
 */

export interface TensorInfo {
  dtype: "BF16" | "F16" | "F32";
  shape: number[];
  /** Absolute byte offsets in the file (header already added). */
  start: number;
  end: number;
}

export interface SafetensorsHeader {
  /** Byte offset where tensor data begins (8 + header length). */
  dataStart: number;
  tensors: Record<string, TensorInfo>;
}

export function parseHeader(bytes: ArrayBuffer): SafetensorsHeader {
  const view = new DataView(bytes);
  const len = Number(view.getBigUint64(0, true));
  if (bytes.byteLength < 8 + len) throw new Error("safetensors header truncated");
  const text = new TextDecoder().decode(new Uint8Array(bytes, 8, len));
  const raw = JSON.parse(text) as Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }>;
  const dataStart = 8 + len;
  const tensors: Record<string, TensorInfo> = {};
  for (const [name, t] of Object.entries(raw)) {
    if (name === "__metadata__") continue;
    const dtype = t.dtype as TensorInfo["dtype"];
    if (dtype !== "BF16" && dtype !== "F16" && dtype !== "F32") throw new Error(`unsupported dtype ${t.dtype} for ${name}`);
    tensors[name] = { dtype, shape: t.shape, start: dataStart + t.data_offsets[0], end: dataStart + t.data_offsets[1] };
  }
  return { dataStart, tensors };
}

/** Header length is in the first 8 bytes; fetch those, then the header itself. */
export async function fetchHeader(url: string, fetchImpl: typeof fetch = fetch): Promise<SafetensorsHeader> {
  const first = await rangeFetch(url, 0, 8, fetchImpl);
  const len = Number(new DataView(first).getBigUint64(0, true));
  if (!Number.isFinite(len) || len <= 0 || len > 64 * 1024 * 1024) throw new Error("bad safetensors header length");
  const rest = await rangeFetch(url, 8, 8 + len, fetchImpl);
  const joined = new Uint8Array(8 + len);
  joined.set(new Uint8Array(first), 0);
  joined.set(new Uint8Array(rest), 8);
  return parseHeader(joined.buffer);
}

export async function rangeFetch(url: string, start: number, end: number, fetchImpl: typeof fetch = fetch): Promise<ArrayBuffer> {
  const r = await fetchImpl(url, { headers: { range: `bytes=${start}-${end - 1}` } });
  if (r.status !== 206 && r.status !== 200) throw new Error(`range fetch ${r.status}`);
  const buf = await r.arrayBuffer();
  if (r.status === 200) {
    // Server ignored the range: slice what we need.
    return buf.slice(start, end);
  }
  if (buf.byteLength !== end - start) throw new Error(`range fetch short read ${buf.byteLength} != ${end - start}`);
  return buf;
}

/** bf16 → f32: the upper 16 bits of an IEEE-754 single. */
export function bf16ToF32(src: ArrayBuffer | Uint8Array, byteOffset = 0, count?: number): Float32Array {
  const bytes = src instanceof Uint8Array ? src : new Uint8Array(src);
  const n = count ?? (bytes.byteLength - byteOffset) >>> 1;
  const out = new Float32Array(n);
  const u32 = new Uint32Array(out.buffer);
  const off = bytes.byteOffset + byteOffset;
  // A view aligned to 2 bytes is always possible; copy through a DataView when it is not.
  if ((off & 1) === 0) {
    const u16 = new Uint16Array(bytes.buffer, off, n);
    for (let i = 0; i < n; i++) u32[i] = u16[i] << 16;
  } else {
    const dv = new DataView(bytes.buffer, off, n * 2);
    for (let i = 0; i < n; i++) u32[i] = dv.getUint16(i * 2, true) << 16;
  }
  return out;
}

export function f16ToF32(src: ArrayBuffer | Uint8Array, byteOffset = 0, count?: number): Float32Array {
  const bytes = src instanceof Uint8Array ? src : new Uint8Array(src);
  const n = count ?? (bytes.byteLength - byteOffset) >>> 1;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const h = dv.getUint16(i * 2, true);
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    out[i] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  return out;
}

export function toF32(info: TensorInfo, bytes: Uint8Array): Float32Array {
  const count = info.shape.reduce((a, b) => a * b, 1);
  if (info.dtype === "BF16") return bf16ToF32(bytes, 0, count);
  if (info.dtype === "F16") return f16ToF32(bytes, 0, count);
  if ((bytes.byteOffset & 3) === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, count).slice();
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer, 0, count);
}

export const LAYER_TENSORS = [
  "input_layernorm.weight",
  "self_attn.q_proj.weight",
  "self_attn.k_proj.weight",
  "self_attn.v_proj.weight",
  "self_attn.o_proj.weight",
  "post_attention_layernorm.weight",
  "mlp.gate_proj.weight",
  "mlp.up_proj.weight",
  "mlp.down_proj.weight",
] as const;

export function layerTensorNames(layer: number): string[] {
  return LAYER_TENSORS.map((t) => `model.layers.${layer}.${t}`);
}

export interface ByteSpan {
  start: number;
  end: number;
}

/** Merge tensor byte ranges into as few HTTP ranges as possible, tolerating small gaps. */
export function mergeSpans(spans: ByteSpan[], gapTolerance = 512 * 1024): ByteSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: ByteSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start - last.end <= gapTolerance) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export interface LoadedTensors {
  get(name: string): Float32Array;
  bytesFetched: number;
}

/**
 * Fetch the named tensors by range request and convert to f32. `onProgress` receives bytes so far.
 */
export async function fetchTensors(
  url: string,
  header: SafetensorsHeader,
  names: string[],
  opts: { fetchImpl?: typeof fetch; onProgress?: (bytes: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<LoadedTensors> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const infos = names.map((n) => {
    const t = header.tensors[n];
    if (!t) throw new Error(`missing tensor ${n}`);
    return [n, t] as const;
  });
  const spans = mergeSpans(infos.map(([, t]) => ({ start: t.start, end: t.end })));
  const total = spans.reduce((a, s) => a + (s.end - s.start), 0);
  let done = 0;
  const chunks: { span: ByteSpan; bytes: Uint8Array }[] = [];
  for (const span of spans) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const buf = await rangeFetch(url, span.start, span.end, fetchImpl);
    chunks.push({ span, bytes: new Uint8Array(buf) });
    done += span.end - span.start;
    opts.onProgress?.(done, total);
  }
  const tensors = new Map<string, Float32Array>();
  for (const [name, t] of infos) {
    const c = chunks.find((x) => x.span.start <= t.start && t.end <= x.span.end)!;
    tensors.set(name, toF32(t, c.bytes.subarray(t.start - c.span.start, t.end - c.span.start)));
  }
  return {
    get: (n) => {
      const v = tensors.get(n);
      if (!v) throw new Error(`tensor not loaded: ${n}`);
      return v;
    },
    bytesFetched: total,
  };
}

/** Tensors from an in-memory file (tests, local tooling). */
export function tensorsFromBuffer(file: ArrayBuffer): LoadedTensors {
  const header = parseHeader(file);
  const bytes = new Uint8Array(file);
  const cache = new Map<string, Float32Array>();
  return {
    get: (n) => {
      let v = cache.get(n);
      if (!v) {
        const t = header.tensors[n];
        if (!t) throw new Error(`missing tensor ${n}`);
        v = toF32(t, bytes.subarray(t.start, t.end));
        cache.set(n, v);
      }
      return v;
    },
    bytesFetched: file.byteLength,
  };
}
