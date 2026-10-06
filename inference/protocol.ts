/**
 * Wire protocol shared by the gateway (Vercel), the relay (Cloudflare Durable Object) and the
 * node client (browser). Pure TypeScript: no Node or DOM APIs beyond TextEncoder / WebCrypto.
 *
 * A frame is `u32 LE header length | header JSON (UTF-8) | payload bytes`. Hidden states travel
 * as f16 (half the bytes of f32; the kernels' own error is far below f16 resolution); top-k logits
 * as (u32 id, f32 logit) pairs.
 */

/* ------------------------------------------------------------------ frames */

export interface Frame<H = Record<string, unknown>> {
  header: H;
  payload: Uint8Array;
}

export function encodeFrame(header: unknown, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + payload.length);
  new DataView(out.buffer).setUint32(0, h.length, true);
  out.set(h, 4);
  out.set(payload, 4 + h.length);
  return out;
}

export function decodeFrame<H = Record<string, unknown>>(data: ArrayBuffer | Uint8Array): Frame<H> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 4) throw new Error("frame too short");
  const hl = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (4 + hl > bytes.length) throw new Error("frame header truncated");
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hl))) as H;
  return { header, payload: bytes.subarray(4 + hl) };
}

/* ------------------------------------------------------------------ f16 payloads */

const f16Scratch = new Float32Array(1);
const f16ScratchU32 = new Uint32Array(f16Scratch.buffer);

export function f32ToF16(v: number): number {
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

export function f16ToF32(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

export function packF16(a: Float32Array): Uint8Array {
  const out = new Uint8Array(a.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < a.length; i++) dv.setUint16(i * 2, f32ToF16(a[i]), true);
  return out;
}

export function unpackF16(bytes: Uint8Array): Float32Array {
  const n = bytes.length >> 1;
  const out = new Float32Array(n);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = f16ToF32(dv.getUint16(i * 2, true));
  return out;
}

/* ------------------------------------------------------------------ top-k payloads */

export const TOP_K = 64;

/**
 * The head stage only projects the last `headColumns(seq)` positions of a lap to logits: a prefill
 * needs just its final column, a decode/verify lap needs every column and is never longer than this.
 */
export const MAX_HEAD_COLUMNS = 8;
export const headColumns = (seq: number) => Math.min(seq, MAX_HEAD_COLUMNS);

export interface TopKColumn {
  ids: Int32Array;
  logits: Float32Array;
}

/** [seq] columns × TOP_K (u32 id, f32 logit). */
export function packTopK(cols: TopKColumn[]): Uint8Array {
  const out = new Uint8Array(cols.length * TOP_K * 8);
  const dv = new DataView(out.buffer);
  cols.forEach((c, ci) => {
    for (let i = 0; i < TOP_K; i++) {
      const o = (ci * TOP_K + i) * 8;
      dv.setUint32(o, i < c.ids.length ? c.ids[i] >>> 0 : 0xffffffff, true);
      dv.setFloat32(o + 4, i < c.logits.length ? c.logits[i] : -Infinity, true);
    }
  });
  return out;
}

export function unpackTopK(bytes: Uint8Array): TopKColumn[] {
  const n = Math.floor(bytes.length / (TOP_K * 8));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: TopKColumn[] = [];
  for (let ci = 0; ci < n; ci++) {
    const ids = new Int32Array(TOP_K);
    const logits = new Float32Array(TOP_K);
    for (let i = 0; i < TOP_K; i++) {
      const o = (ci * TOP_K + i) * 8;
      ids[i] = dv.getUint32(o, true) | 0;
      logits[i] = dv.getFloat32(o + 4, true);
    }
    out.push({ ids, logits });
  }
  return out;
}

/** Top-k of a logits row, descending. */
export function topKOf(logits: Float32Array, k = TOP_K): TopKColumn {
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

/** Replicas agree when their outputs are within this relative RMS. */
export const REPLICA_TOLERANCE = 2e-3;
/** Two top-k lists must share at least this many ids per column to be comparable at all. */
export const TOPK_MIN_COMMON = 48;

/**
 * Distance between two top-k payloads: relative RMS over the logits of ids both lists contain,
 * Infinity if they share too few ids (a different distribution, or garbage).
 */
export function compareTopK(a: TopKColumn[], b: TopKColumn[]): number {
  if (a.length !== b.length) return Infinity;
  let worst = 0;
  for (let ci = 0; ci < a.length; ci++) {
    const pos = new Map<number, number>();
    for (let i = 0; i < a[ci].ids.length; i++) pos.set(a[ci].ids[i], i);
    const la: number[] = [];
    const lb: number[] = [];
    for (let i = 0; i < b[ci].ids.length; i++) {
      const j = pos.get(b[ci].ids[i]);
      if (j !== undefined) {
        la.push(a[ci].logits[j]);
        lb.push(b[ci].logits[i]);
      }
    }
    if (la.length < TOPK_MIN_COMMON) return Infinity;
    worst = Math.max(worst, relativeRms(Float32Array.from(la), Float32Array.from(lb)));
  }
  return worst;
}

/** Compare two hop outputs of the same kind. */
export function compareOutputs(kind: "hidden" | "topk", a: Uint8Array, b: Uint8Array): number {
  if (kind === "hidden") return relativeRms(unpackF16(a), unpackF16(b));
  return compareTopK(unpackTopK(a), unpackTopK(b));
}

/* ------------------------------------------------------------------ messages */

export type Role = "node" | "gateway";

export interface Ticket {
  role: Role;
  model: string;
  nodeId?: string;
  stage?: number;
  /** Unix ms. */
  exp: number;
}

/** Nodes in a stage, primary first. */
export interface LapStage {
  stage: number;
  nodes: string[];
}

/** Gateway → relay: run one lap (prefill or a decode/verify batch) through the pipeline. */
export interface LapMsg {
  t: "lap";
  session: string;
  step: number;
  plan: LapStage[];
  seq: number;
  positions: number[];
  cacheLen: number;
  /** Per-hop deadline in ms. */
  hopMs: number;
  // payload: u32 token ids [seq]
}

export interface EndMsg {
  t: "end";
  session: string;
}

/** Relay → node: run your stage. */
export interface HopMsg {
  t: "hop";
  hop: string;
  session: string;
  step: number;
  stage: number;
  seq: number;
  positions: number[];
  cacheLen: number;
  kind: "tokens" | "hidden";
  // payload: u32 tokens or f16 hidden [seq, hidden]
}

export interface DropMsg {
  t: "drop";
  session: string;
}

/** Node → relay: the result of a hop. */
export interface ResultMsg {
  t: "result";
  hop: string;
  ok: boolean;
  gpuMs: number;
  cacheLen: number;
  error?: string;
  // payload: f16 hidden or top-k
}

/** Relay → gateway: one node's result for one stage of a lap (for accounting and verification). */
export interface StageMsg {
  t: "stage";
  session: string;
  step: number;
  stage: number;
  nodeId: string;
  role: "primary" | "replica";
  ok: boolean;
  /** Wall ms from hop sent to result received at the relay. */
  ms: number;
  gpuMs: number;
  /** Distance to the sibling's output; null when there was nothing to compare against. */
  rms: number | null;
  error?: string;
}

/** Relay → gateway: the lap finished; payload = top-k per column from the head stage. */
export interface DoneMsg {
  t: "done";
  session: string;
  step: number;
  seq: number;
  /** Relay-side wall ms for the whole lap. */
  ms: number;
}

export interface FailMsg {
  t: "fail";
  session: string;
  step: number;
  stage: number;
  reason: string;
}

export type GatewayInbound = StageMsg | DoneMsg | FailMsg;
export type NodeInbound = HopMsg | DropMsg;

export interface PresenceNode {
  nodeId: string;
  stage: number;
  since: number;
}

/* ------------------------------------------------------------------ tickets (HMAC-SHA256, WebCrypto) */

const b64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(s) : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (s: string) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function hmac(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, data as BufferSource);
  return new Uint8Array(sig);
}

export async function signTicket(t: Ticket, secret: string): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify(t));
  const sig = await hmac(secret, body);
  return `${b64url(body)}.${b64url(sig)}`;
}

export async function verifyTicket(token: string, secret: string, now = Date.now()): Promise<Ticket | null> {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = unb64url(token.slice(0, dot));
  const sig = unb64url(token.slice(dot + 1));
  const expect = await hmac(secret, body);
  if (sig.length !== expect.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig[i] ^ expect[i];
  if (diff !== 0) return null;
  try {
    const t = JSON.parse(new TextDecoder().decode(body)) as Ticket;
    if (typeof t.exp !== "number" || t.exp < now) return null;
    if (t.role !== "node" && t.role !== "gateway") return null;
    return t;
  } catch {
    return null;
  }
}
