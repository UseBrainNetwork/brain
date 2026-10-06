import { rangeFetch } from "./safetensors";

/**
 * GGUF reader with HTTP range support: header + tensor table, Q4_0 / Q8_0 / F16 / F32 tensors,
 * dequantisation for the CPU reference, and repacking into the layout the WebGPU kernels read
 * (packed nibbles or int8 in one buffer, f16 block scales two-per-u32 in another).
 *
 * The block layout follows ggml: 32 elements per block; Q4_0 = f16 scale + 16 bytes of nibbles
 * (element i in the low nibble of byte i for i < 16, high nibble of byte i-16 otherwise), value =
 * scale × (nibble − 8); Q8_0 = f16 scale + 32 int8, value = scale × q. Kernel and repack layout
 * follow the cooperative-GEMV design in Nehanth/pooled (MIT); see NOTICE.
 */

export const GGML_F32 = 0;
export const GGML_F16 = 1;
export const GGML_Q4_0 = 2;
export const GGML_Q4_1 = 3;
export const GGML_Q8_0 = 8;
export const GGML_Q6_K = 14;
export const GGML_BF16 = 30;

export const QK = 32;
const QK_K = 256;

export interface GgufTensorInfo {
  name: string;
  /** Torch order: [rows(out), cols(in)] for matrices. */
  shape: number[];
  ggmlType: number;
  nElems: number;
  /** Absolute byte offsets in the file. */
  start: number;
  end: number;
}

export interface GgufHeader {
  meta: Record<string, unknown>;
  tensors: Record<string, GgufTensorInfo>;
  dataStart: number;
  headerBytes: number;
}

export function ggmlTypeBytes(type: number, n: number): number {
  switch (type) {
    case GGML_F32:
      return n * 4;
    case GGML_F16:
    case GGML_BF16:
      return n * 2;
    case GGML_Q4_0:
      return (n / QK) * 18;
    case GGML_Q4_1:
      return (n / QK) * 20;
    case GGML_Q8_0:
      return (n / QK) * 34;
    case GGML_Q6_K:
      return (n / QK_K) * 210;
    default:
      return -1;
  }
}

export function ggmlTypeName(type: number): string {
  return type === GGML_F32 ? "F32" : type === GGML_F16 ? "F16" : type === GGML_BF16 ? "BF16" : type === GGML_Q4_0 ? "Q4_0" : type === GGML_Q4_1 ? "Q4_1" : type === GGML_Q8_0 ? "Q8_0" : type === GGML_Q6_K ? "Q6_K" : `type${type}`;
}

const T_U8 = 0, T_I8 = 1, T_U16 = 2, T_I16 = 3, T_U32 = 4, T_I32 = 5, T_F32 = 6, T_BOOL = 7, T_STR = 8, T_ARR = 9, T_U64 = 10, T_I64 = 11, T_F64 = 12;

/**
 * Parse a GGUF v2/v3 header from a buffer that holds at least the header. Tokenizer arrays
 * (hundreds of thousands of strings) are skipped unless `keepTokenizer` is set.
 */
export function parseGgufHeader(buf: ArrayBuffer, opts: { keepTokenizer?: boolean } = {}): GgufHeader {
  const dv = new DataView(buf);
  let off = 0;
  const need = (n: number) => {
    if (off + n > buf.byteLength) throw new Error("gguf header truncated");
  };
  const u32 = () => {
    need(4);
    const v = dv.getUint32(off, true);
    off += 4;
    return v;
  };
  const u64 = () => {
    need(8);
    const v = Number(dv.getBigUint64(off, true));
    off += 8;
    return v;
  };
  const dec = new TextDecoder();
  const str = (skip: boolean) => {
    const n = u64();
    need(n);
    const s = skip ? undefined : dec.decode(new Uint8Array(buf, off, n));
    off += n;
    return s;
  };
  const value = (t: number, skip: boolean): unknown => {
    switch (t) {
      case T_U8:
        need(1);
        return dv.getUint8(off++);
      case T_I8:
        need(1);
        return dv.getInt8(off++);
      case T_U16: {
        need(2);
        const v = dv.getUint16(off, true);
        off += 2;
        return v;
      }
      case T_I16: {
        need(2);
        const v = dv.getInt16(off, true);
        off += 2;
        return v;
      }
      case T_U32:
        return u32();
      case T_I32: {
        need(4);
        const v = dv.getInt32(off, true);
        off += 4;
        return v;
      }
      case T_F32: {
        need(4);
        const v = dv.getFloat32(off, true);
        off += 4;
        return v;
      }
      case T_BOOL:
        need(1);
        return dv.getUint8(off++) !== 0;
      case T_STR:
        return str(skip);
      case T_U64:
        return u64();
      case T_I64: {
        need(8);
        const v = Number(dv.getBigInt64(off, true));
        off += 8;
        return v;
      }
      case T_F64: {
        need(8);
        const v = dv.getFloat64(off, true);
        off += 8;
        return v;
      }
      case T_ARR: {
        const et = u32();
        const n = u64();
        const out = skip ? undefined : new Array<unknown>(n);
        for (let i = 0; i < n; i++) {
          const v = value(et, skip);
          if (out) out[i] = v;
        }
        return out;
      }
      default:
        throw new Error(`bad gguf value type ${t}`);
    }
  };

  if (u32() !== 0x46554747) throw new Error("not a GGUF file");
  const version = u32();
  if (version < 2) throw new Error("gguf v1 unsupported");
  const nTensors = u64();
  const nKv = u64();
  const meta: Record<string, unknown> = {};
  for (let i = 0; i < nKv; i++) {
    const key = str(false)!;
    const skip = !opts.keepTokenizer && key.startsWith("tokenizer.ggml.");
    const v = value(u32(), skip);
    if (!skip) meta[key] = v;
  }
  const infos: { name: string; shape: number[]; ggmlType: number; offset: number }[] = [];
  for (let i = 0; i < nTensors; i++) {
    const name = str(false)!;
    const nd = u32();
    const dims: number[] = [];
    for (let d = 0; d < nd; d++) dims.push(u64());
    const ggmlType = u32();
    const offset = u64();
    infos.push({ name, shape: dims.reverse(), ggmlType, offset });
  }
  const align = Number(meta["general.alignment"] ?? 32);
  const dataStart = Math.ceil(off / align) * align;
  const tensors: Record<string, GgufTensorInfo> = {};
  for (const t of infos) {
    const n = t.shape.reduce((a, b) => a * b, 1);
    const bytes = ggmlTypeBytes(t.ggmlType, n);
    tensors[t.name] = { name: t.name, shape: t.shape, ggmlType: t.ggmlType, nElems: n, start: dataStart + t.offset, end: bytes < 0 ? -1 : dataStart + t.offset + bytes };
  }
  return { meta, tensors, dataStart, headerBytes: off };
}

/**
 * Fetch the header by range request. The header length is not stored up front, so fetch a first
 * chunk and grow until the parser stops reporting truncation.
 */
export async function fetchGgufHeader(url: string, fetchImpl: typeof fetch = fetch, opts: { keepTokenizer?: boolean } = {}): Promise<GgufHeader> {
  let size = 2 * 1024 * 1024;
  for (let attempt = 0; attempt < 6; attempt++) {
    const buf = await rangeFetch(url, 0, size, fetchImpl);
    try {
      return parseGgufHeader(buf, opts);
    } catch (e) {
      if (!(e instanceof Error) || !/truncated/.test(e.message)) throw e;
      size *= 4;
    }
  }
  throw new Error("gguf header too large");
}

/* ------------------------------------------------------------------ f16 */

const f16Scratch = new Float32Array(1);
const f16ScratchU32 = new Uint32Array(f16Scratch.buffer);

export function f16Bits(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** f32 → f16 bits, round to nearest (ties away). */
export function f32ToF16Bits(v: number): number {
  f16Scratch[0] = v;
  const x = f16ScratchU32[0];
  const sign = (x >>> 16) & 0x8000;
  let e = (x >>> 23) & 0xff;
  let m = x & 0x7fffff;
  if (e === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
  e = e - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  return sign | ((e << 10) + ((m + 0x1000) >> 13));
}

/* ------------------------------------------------------------------ dequant */

export function dequantToF32(info: GgufTensorInfo, bytes: Uint8Array): Float32Array {
  const n = info.nElems;
  if (info.ggmlType === GGML_F32) {
    if ((bytes.byteOffset & 3) === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, n).slice();
    return new Float32Array(new Uint8Array(bytes).buffer, 0, n);
  }
  if (info.ggmlType === GGML_F16 || info.ggmlType === GGML_BF16) {
    const out = new Float32Array(n);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    if (info.ggmlType === GGML_F16) for (let i = 0; i < n; i++) out[i] = f16Bits(dv.getUint16(i * 2, true));
    else {
      const u32 = new Uint32Array(out.buffer);
      for (let i = 0; i < n; i++) u32[i] = dv.getUint16(i * 2, true) << 16;
    }
    return out;
  }
  const out = new Float32Array(n);
  const nb = n / QK;
  if (info.ggmlType === GGML_Q8_0) {
    for (let b = 0; b < nb; b++) {
      const base = b * 34;
      const d = f16Bits(bytes[base] | (bytes[base + 1] << 8));
      for (let i = 0; i < QK; i++) {
        const q = bytes[base + 2 + i];
        out[b * QK + i] = d * (q > 127 ? q - 256 : q);
      }
    }
    return out;
  }
  if (info.ggmlType === GGML_Q4_0) {
    for (let b = 0; b < nb; b++) {
      const base = b * 18;
      const d = f16Bits(bytes[base] | (bytes[base + 1] << 8));
      for (let i = 0; i < 16; i++) {
        const byte = bytes[base + 2 + i];
        out[b * QK + i] = d * ((byte & 0xf) - 8);
        out[b * QK + i + 16] = d * ((byte >> 4) - 8);
      }
    }
    return out;
  }
  if (info.ggmlType === GGML_Q4_1) {
    for (let b = 0; b < nb; b++) {
      const base = b * 20;
      const d = f16Bits(bytes[base] | (bytes[base + 1] << 8));
      const m = f16Bits(bytes[base + 2] | (bytes[base + 3] << 8));
      for (let i = 0; i < 16; i++) {
        const byte = bytes[base + 4 + i];
        out[b * QK + i] = d * (byte & 0xf) + m;
        out[b * QK + i + 16] = d * (byte >> 4) + m;
      }
    }
    return out;
  }
  if (info.ggmlType === GGML_Q6_K) {
    // ggml block_q6_K: ql[128] low nibbles, qh[64] high 2 bits, scales[16] int8, d f16 (210 bytes).
    const nbk = n / QK_K;
    for (let b = 0; b < nbk; b++) {
      const base = b * 210;
      const d = f16Bits(bytes[base + 208] | (bytes[base + 209] << 8));
      let y = b * QK_K;
      let ql = base;
      let qh = base + 128;
      let sc = base + 192;
      for (let half = 0; half < 2; half++) {
        for (let l = 0; l < 32; l++) {
          const is = l >> 4;
          const q1 = ((bytes[ql + l] & 0xf) | (((bytes[qh + l] >> 0) & 3) << 4)) - 32;
          const q2 = ((bytes[ql + l + 32] & 0xf) | (((bytes[qh + l] >> 2) & 3) << 4)) - 32;
          const q3 = ((bytes[ql + l] >> 4) | (((bytes[qh + l] >> 4) & 3) << 4)) - 32;
          const q4 = ((bytes[ql + l + 32] >> 4) | (((bytes[qh + l] >> 6) & 3) << 4)) - 32;
          const s0 = (bytes[sc + is] << 24) >> 24;
          const s2 = (bytes[sc + is + 2] << 24) >> 24;
          const s4 = (bytes[sc + is + 4] << 24) >> 24;
          const s6 = (bytes[sc + is + 6] << 24) >> 24;
          out[y + l] = d * s0 * q1;
          out[y + l + 32] = d * s2 * q2;
          out[y + l + 64] = d * s4 * q3;
          out[y + l + 96] = d * s6 * q4;
        }
        y += 128;
        ql += 64;
        qh += 32;
        sc += 8;
      }
    }
    return out;
  }
  throw new Error(`unsupported ggml type ${ggmlTypeName(info.ggmlType)} for ${info.name}`);
}

/** Quantise f32 values to Q8_0 blocks, writing into `qs`/`sc16` at block `b0`. */
function quantizeQ8Into(data: Float32Array, qs: Uint8Array, sc16: Uint16Array, b0: number): void {
  const nb = data.length / QK;
  for (let b = 0; b < nb; b++) {
    let amax = 0;
    for (let i = b * QK; i < b * QK + QK; i++) amax = Math.max(amax, Math.abs(data[i]));
    const h = f32ToF16Bits(amax / 127 || 1);
    sc16[b0 + b] = h;
    const d = f16Bits(h) || 1;
    for (let i = 0; i < QK; i++) qs[(b0 + b) * QK + i] = Math.max(-127, Math.min(127, Math.round(data[b * QK + i] / d))) & 0xff;
  }
}

/**
 * Requantise a matrix of any supported type to Q8_0 for the GPU, a chunk of rows at a time so a
 * 300 MB embedding never exists as f32 all at once (a 1.5 GB allocation a browser tab refuses).
 */
export function requantQ8(info: GgufTensorInfo, bytes: Uint8Array): { qs: Uint8Array; scales: Uint32Array } {
  const [rows, cols] = info.shape;
  const n = rows * cols;
  const rowBytes = ggmlTypeBytes(info.ggmlType, cols);
  const qs = new Uint8Array(n);
  const scales = new Uint32Array(Math.ceil(n / QK / 2));
  const sc16 = new Uint16Array(scales.buffer);
  const chunk = Math.max(1, Math.floor((8 * 1024 * 1024) / (cols * 4)));
  for (let r0 = 0; r0 < rows; r0 += chunk) {
    const rc = Math.min(chunk, rows - r0);
    const sub: GgufTensorInfo = { ...info, nElems: rc * cols, shape: [rc, cols] };
    const f = dequantToF32(sub, bytes.subarray(r0 * rowBytes, (r0 + rc) * rowBytes));
    quantizeQ8Into(f, qs, sc16, (r0 * cols) / QK);
  }
  return { qs, scales };
}

/* ------------------------------------------------------------------ GPU repack */

export type WeightEntry =
  | { kind: "f32"; data: Float32Array; shape: number[] }
  | {
      kind: "q4" | "q8";
      /** Q4: 16 bytes per block (nibbles); Q8: 32 bytes per block (int8). u32-aligned. */
      qs: Uint8Array;
      /** f16 block scales, two per u32 word. */
      scales: Uint32Array;
      shape: number[];
    };

export function entryBytes(e: WeightEntry): number {
  return e.kind === "f32" ? e.data.byteLength : e.qs.byteLength + e.scales.byteLength;
}

function repack(info: GgufTensorInfo, bytes: Uint8Array, blockBytes: number): { qs: Uint8Array; scales: Uint32Array } {
  const nb = info.nElems / QK;
  const payload = blockBytes - 2;
  const qs = new Uint8Array(Math.ceil((nb * payload) / 4) * 4);
  const scales = new Uint32Array(Math.ceil(nb / 2));
  const sc16 = new Uint16Array(scales.buffer);
  for (let b = 0; b < nb; b++) {
    const base = b * blockBytes;
    sc16[b] = bytes[base] | (bytes[base + 1] << 8);
    qs.set(bytes.subarray(base + 2, base + blockBytes), b * payload);
  }
  return { qs, scales };
}

/** Convert a tensor's file bytes into the entry the GPU stage uploads. Pure and deterministic. */
export function toWeightEntry(info: GgufTensorInfo, bytes: Uint8Array): WeightEntry {
  if (info.shape.length === 2) {
    if (info.ggmlType === GGML_Q4_0) return { kind: "q4", ...repack(info, bytes, 18), shape: info.shape };
    if (info.ggmlType === GGML_Q8_0) return { kind: "q8", ...repack(info, bytes, 34), shape: info.shape };
    // Other quantisations (Q4_1 / Q6_K tensors inside "Q4_0" files) have no kernel: requantise to Q8.
    if (info.ggmlType === GGML_Q4_1 || info.ggmlType === GGML_Q6_K) return { kind: "q8", ...requantQ8(info, bytes), shape: info.shape };
  }
  return { kind: "f32", data: dequantToF32(info, bytes), shape: info.shape };
}

/** Dequantise one entry back to f32 (the CPU reference runs on exactly what the GPU holds). */
export function entryToF32(e: WeightEntry): Float32Array {
  if (e.kind === "f32") return e.data;
  const n = e.shape.reduce((a, b) => a * b, 1);
  const out = new Float32Array(n);
  const sc16 = new Uint16Array(e.scales.buffer);
  const nb = n / QK;
  if (e.kind === "q8") {
    for (let b = 0; b < nb; b++) {
      const d = f16Bits(sc16[b]);
      for (let i = 0; i < QK; i++) {
        const q = e.qs[b * QK + i];
        out[b * QK + i] = d * (q > 127 ? q - 256 : q);
      }
    }
  } else {
    for (let b = 0; b < nb; b++) {
      const d = f16Bits(sc16[b]);
      for (let i = 0; i < 16; i++) {
        const byte = e.qs[b * 16 + i];
        out[b * QK + i] = d * ((byte & 0xf) - 8);
        out[b * QK + i + 16] = d * ((byte >> 4) - 8);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ names */

export const GGUF_EMBED = "token_embd.weight";
export const GGUF_FINAL_NORM = "output_norm.weight";
export const GGUF_OUTPUT = "output.weight";

export interface GgufLayerNames {
  ln1: string;
  wq: string;
  wk: string;
  wv: string;
  wo: string;
  qNorm: string;
  kNorm: string;
  ln2: string;
  wgate: string;
  wup: string;
  wdown: string;
}

export function ggufLayerNames(layer: number): GgufLayerNames {
  const p = `blk.${layer}.`;
  return {
    ln1: `${p}attn_norm.weight`,
    wq: `${p}attn_q.weight`,
    wk: `${p}attn_k.weight`,
    wv: `${p}attn_v.weight`,
    wo: `${p}attn_output.weight`,
    qNorm: `${p}attn_q_norm.weight`,
    kNorm: `${p}attn_k_norm.weight`,
    ln2: `${p}ffn_norm.weight`,
    wgate: `${p}ffn_gate.weight`,
    wup: `${p}ffn_up.weight`,
    wdown: `${p}ffn_down.weight`,
  };
}

/** Byte size of one layer's tensors as stored in the file (missing optional tensors count as 0). */
export function ggufLayerBytes(h: GgufHeader, layer: number): number {
  let total = 0;
  for (const n of Object.values(ggufLayerNames(layer))) {
    const t = h.tensors[n];
    if (t) total += t.end - t.start;
  }
  return total;
}

export function ggufTensorBytes(h: GgufHeader, name: string): number {
  const t = h.tensors[name];
  return t ? t.end - t.start : 0;
}

/* ------------------------------------------------------------------ fetching */

export interface LoadedEntries {
  get(name: string): WeightEntry;
  has(name: string): boolean;
  bytesFetched: number;
}

/**
 * Range-fetch the named tensors (one request per tensor, in order; the per-tensor granularity is
 * what lets the Cache API hold each slice separately) and convert them to GPU entries.
 */
export async function fetchGgufEntries(
  url: string,
  header: GgufHeader,
  names: string[],
  opts: { fetchImpl?: typeof fetch; onProgress?: (bytes: number, total: number) => void; signal?: AbortSignal; optional?: Set<string> } = {},
): Promise<LoadedEntries> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const infos = names.flatMap((n) => {
    const t = header.tensors[n];
    if (!t) {
      if (opts.optional?.has(n)) return [];
      throw new Error(`missing tensor ${n}`);
    }
    if (t.end < 0) throw new Error(`unsupported tensor type ${ggmlTypeName(t.ggmlType)} for ${n}`);
    return [t];
  });
  const total = infos.reduce((a, t) => a + (t.end - t.start), 0);
  let done = 0;
  const entries = new Map<string, WeightEntry>();
  for (const t of infos) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const buf = await rangeFetch(url, t.start, t.end, fetchImpl);
    entries.set(t.name, toWeightEntry(t, new Uint8Array(buf)));
    done += t.end - t.start;
    opts.onProgress?.(done, total);
  }
  return {
    get: (n) => {
      const e = entries.get(n);
      if (!e) throw new Error(`tensor not loaded: ${n}`);
      return e;
    },
    has: (n) => entries.has(n),
    bytesFetched: total,
  };
}

/** Entries from an in-memory file (tests, local tooling). */
export function entriesFromBuffer(file: ArrayBuffer, header = parseGgufHeader(file)): LoadedEntries {
  const bytes = new Uint8Array(file);
  const cache = new Map<string, WeightEntry>();
  return {
    get: (n) => {
      let e = cache.get(n);
      if (!e) {
        const t = header.tensors[n];
        if (!t) throw new Error(`missing tensor ${n}`);
        e = toWeightEntry(t, bytes.subarray(t.start, t.end));
        cache.set(n, e);
      }
      return e;
    },
    has: (n) => Boolean(header.tensors[n]),
    bytesFetched: file.byteLength,
  };
}
