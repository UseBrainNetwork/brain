import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SMOLLM2_135M, layerMacs, stagePlan, stageUnits } from "./config";
import { createKv, embed, finalLogits, layerForward, layerWeightsFrom, matmulT, mulberry32, relativeRms, rmsnorm, ropeInPlace, sampleTopK, stageForward, topK } from "./llama";
import { bf16ToF32, mergeSpans, parseHeader, tensorsFromBuffer } from "./safetensors";
import { StreamDecoder, Tokenizer, chatPrompt } from "./tokenizer";

/**
 * Real-weights integration test. Runs only when the SmolLM2 checkpoint is available locally
 * (BRAIN_SMOLLM_DIR with model.safetensors + tokenizer.json); CI skips it.
 */
const DIR = process.env.BRAIN_SMOLLM_DIR ?? "/tmp/smollm";
const HAVE_WEIGHTS = existsSync(path.join(DIR, "model.safetensors")) && existsSync(path.join(DIR, "tokenizer.json"));

describe("llama primitives", () => {
  it("rmsnorm scales rows to unit RMS times the weight", () => {
    const x = new Float32Array([3, 4, 0, 0]);
    const w = new Float32Array([1, 1, 1, 1]);
    const y = rmsnorm(x, w, 0, 1, 4);
    // rms = sqrt((9+16)/4) = 2.5
    expect(y[0]).toBeCloseTo(1.2, 5);
    expect(y[1]).toBeCloseTo(1.6, 5);
  });

  it("matmulT multiplies by the transposed [out,in] weight and can accumulate", () => {
    const x = new Float32Array([1, 2, 3]);
    const w = new Float32Array([1, 0, 0, 0, 1, 0, 1, 1, 1]); // rows: e1, e2, ones
    const y = matmulT(x, w, 1, 3, 3);
    expect(Array.from(y)).toEqual([1, 2, 6]);
    const acc = matmulT(x, w, 1, 3, 3, new Float32Array([10, 10, 10]), true);
    expect(Array.from(acc)).toEqual([11, 12, 16]);
  });

  it("rope preserves vector norm and is the identity at position 0", () => {
    const v = new Float32Array([0.3, -1.2, 2.0, 0.7]);
    const a = v.slice();
    ropeInPlace(a, 1, 1, 4, [0], 10000);
    expect(Array.from(a)).toEqual(Array.from(v));
    const b = v.slice();
    ropeInPlace(b, 1, 1, 4, [37], 10000);
    const n = (z: Float32Array) => Math.hypot(...Array.from(z));
    expect(n(b)).toBeCloseTo(n(v), 5);
    expect(Array.from(b)).not.toEqual(Array.from(v));
  });

  it("rope rotates equal relative positions equally (dot product depends on the offset only)", () => {
    const q = new Float32Array([1, 0.5, -0.25, 2]);
    const k = new Float32Array([0.1, 0.9, 1.5, -0.4]);
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, v, i) => s + v * b[i], 0);
    const q1 = q.slice(), k1 = k.slice(), q2 = q.slice(), k2 = k.slice();
    ropeInPlace(q1, 1, 1, 4, [10], 10000);
    ropeInPlace(k1, 1, 1, 4, [7], 10000);
    ropeInPlace(q2, 1, 1, 4, [103], 10000);
    ropeInPlace(k2, 1, 1, 4, [100], 10000);
    expect(dot(q1, k1)).toBeCloseTo(dot(q2, k2), 4);
  });

  it("topK returns the k largest in descending order; greedy sampling picks the first", () => {
    const l = new Float32Array([0.1, 5, -2, 3, 4.5]);
    const tk = topK(l, 3);
    expect(Array.from(tk.ids)).toEqual([1, 4, 3]);
    expect(sampleTopK(tk, { temperature: 0, topP: 1, seed: 1 }, mulberry32(1))).toBe(1);
    // With temperature, sampling is deterministic for a seed and stays within the nucleus.
    const a = sampleTopK(tk, { temperature: 0.7, topP: 0.9, seed: 9 }, mulberry32(9));
    const b = sampleTopK(tk, { temperature: 0.7, topP: 0.9, seed: 9 }, mulberry32(9));
    expect(a).toBe(b);
    expect([1, 4, 3]).toContain(a);
  });

  it("a layer with cache gives identical results whether tokens arrive together or one at a time", () => {
    const cfg = { ...SMOLLM2_135M.config, hidden: 16, intermediate: 32, layers: 1, heads: 4, kvHeads: 2, vocab: 8 };
    const rnd = mulberry32(3);
    const f = (n: number) => Float32Array.from({ length: n }, () => (rnd() - 0.5) * 0.4);
    const w = { ln1: f(16).map((v) => v + 1), wq: f(256), wk: f(8 * 16), wv: f(8 * 16), wo: f(256), ln2: f(16).map((v) => v + 1), wgate: f(32 * 16), wup: f(32 * 16), wdown: f(16 * 32) };
    const x = f(3 * 16);
    const together = x.slice();
    layerForward(cfg, w, together, 3, [0, 1, 2], createKv(cfg, 8));
    const kv = createKv(cfg, 8);
    const one = x.slice();
    for (let s = 0; s < 3; s++) {
      const row = one.subarray(s * 16, (s + 1) * 16);
      layerForward(cfg, w, row, 1, [s], kv);
    }
    expect(relativeRms(together, one)).toBeLessThan(1e-5);
  });

  it("stage plan splits layers evenly and units follow MACs", () => {
    expect(stagePlan(SMOLLM2_135M)).toEqual([
      { stage: 0, layerFrom: 0, layerTo: 10 },
      { stage: 1, layerFrom: 10, layerTo: 20 },
      { stage: 2, layerFrom: 20, layerTo: 30 },
    ]);
    expect(layerMacs(SMOLLM2_135M.config)).toBe(663_552 + 221_184 + 2_654_208); // q/o + k/v + mlp projections
    expect(stageUnits(SMOLLM2_135M.config, 10, 1)).toBe(34);
  });
});

describe("safetensors", () => {
  it("bf16 → f32 keeps the top 16 bits", () => {
    // 1.0 = 0x3F80 bf16, -2.5 = 0xC020
    const bytes = new Uint8Array([0x80, 0x3f, 0x20, 0xc0]);
    expect(Array.from(bf16ToF32(bytes))).toEqual([1, -2.5]);
  });

  it("parses a header and merges nearby spans", () => {
    const header = JSON.stringify({ a: { dtype: "BF16", shape: [2], data_offsets: [0, 4] }, b: { dtype: "F32", shape: [1], data_offsets: [4, 8] } });
    const hb = new TextEncoder().encode(header);
    const file = new Uint8Array(8 + hb.length + 8);
    new DataView(file.buffer).setBigUint64(0, BigInt(hb.length), true);
    file.set(hb, 8);
    const h = parseHeader(file.buffer);
    expect(h.tensors.a.start).toBe(8 + hb.length);
    expect(h.tensors.b.end).toBe(8 + hb.length + 8);
    expect(mergeSpans([{ start: 0, end: 10 }, { start: 12, end: 20 }, { start: 5000, end: 6000 }], 100)).toEqual([
      { start: 0, end: 20 },
      { start: 5000, end: 6000 },
    ]);
  });
});

describe.skipIf(!HAVE_WEIGHTS)("SmolLM2-135M on real weights (CPU reference)", () => {
  const file = readFileSync(path.join(DIR, "model.safetensors"));
  const t = tensorsFromBuffer(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const tok = new Tokenizer(JSON.parse(readFileSync(path.join(DIR, "tokenizer.json"), "utf8")));
  const cfg = SMOLLM2_135M.config;

  it("tokenizer round-trips text and matches known ids", () => {
    const s = "Hello world! The year is 2024, café ☕.";
    const ids = tok.encode(s);
    expect(tok.decode(ids)).toBe(s);
    // Digits are split individually by the pre-tokenizer.
    const digits = tok.encode("2024");
    expect(digits).toHaveLength(4);
    expect(tok.tokenId("<|im_start|>")).toBe(1);
    expect(tok.encode("<|im_start|>user\nhi<|im_end|>")).toEqual([1, ...tok.encode("user\nhi"), 2]);
    const sd = new StreamDecoder(tok);
    expect(ids.map((i) => sd.push(i)).join("") + sd.flush()).toBe(s);
  });

  it("answers a factual prompt greedily through all 30 layers", () => {
    const prompt = chatPrompt([{ role: "user", content: "What is the capital of France? Answer in one word." }]);
    const ids = tok.encode(prompt);
    const layers = Array.from({ length: cfg.layers }, (_, i) => layerWeightsFrom(t, i));
    const kvs = layers.map(() => createKv(cfg, 64));
    const embedW = t.get("model.embed_tokens.weight");
    const normW = t.get("model.norm.weight");
    const x = embed(embedW, cfg.hidden, ids);
    const positions = ids.map((_, i) => i);
    stageForward(cfg, layers, kvs, x, ids.length, positions);
    const out: number[] = [];
    let last = x.subarray((ids.length - 1) * cfg.hidden);
    for (let step = 0; step < 6; step++) {
      const logits = finalLogits(cfg, normW, embedW, last);
      const next = topK(logits, 1).ids[0];
      if (cfg.eos.includes(next)) break;
      out.push(next);
      const row = embed(embedW, cfg.hidden, [next]);
      stageForward(cfg, layers, kvs, row, 1, [ids.length + step]);
      last = row;
    }
    const text = tok.decode(out);
    expect(text.toLowerCase()).toContain("paris");
  }, 120_000);
});
