import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_LADDER, MODEL_PREFERENCE, QWEN3_0_6B, QWEN3_0_6B_SOLO, QWEN3_1_7B, QWEN3_1_7B_SOLO, QWEN3_4B, isSingleTab, layerMacs, nodeFitsStage, stagePlan, stageUnits } from "./config";
import { GGML_Q4_0, GGML_Q8_0, dequantToF32, entriesFromBuffer, entryToF32, f16Bits, f32ToF16Bits, parseGgufHeader, toWeightEntry, type GgufTensorInfo } from "./gguf";
import { createKv, embed, finalLogits, layerForward, layerWeightsFrom, matmulT, mulberry32, relativeRms, rmsnorm, ropeInPlace, sampleTopK, stageForward, topK } from "./llama";
import { StreamDecoder, Tokenizer, chatPrompt } from "./tokenizer";

/**
 * Real-weights integration test. Runs only when the Qwen3-0.6B Q8_0 GGUF is available locally
 * (BRAIN_QWEN_DIR with model.gguf + tokenizer.json); CI skips it.
 */
const DIR = process.env.BRAIN_QWEN_DIR ?? "/tmp/qwen3-0.6b";
const HAVE_WEIGHTS = existsSync(path.join(DIR, "model.gguf")) && existsSync(path.join(DIR, "tokenizer.json"));

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

  it("a layer with cache gives identical results whether tokens arrive together or one at a time (with q/k norm)", () => {
    const cfg = { ...QWEN3_0_6B.config, hidden: 16, intermediate: 32, layers: 1, heads: 4, kvHeads: 2, headDim: 8, vocab: 8 };
    const rnd = mulberry32(3);
    const f = (n: number) => Float32Array.from({ length: n }, () => (rnd() - 0.5) * 0.4);
    const w = { ln1: f(16).map((v) => v + 1), wq: f(32 * 16), wk: f(16 * 16), wv: f(16 * 16), wo: f(16 * 32), qNorm: f(8).map((v) => v + 1), kNorm: f(8).map((v) => v + 1), ln2: f(16).map((v) => v + 1), wgate: f(32 * 16), wup: f(32 * 16), wdown: f(16 * 32) };
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

  it("stage plans cover every layer, put the embedding first and the head last, and units follow MACs", () => {
    for (const m of [QWEN3_0_6B, QWEN3_1_7B, QWEN3_4B]) {
      const plan = stagePlan(m);
      expect(plan[0]).toMatchObject({ stage: 0, layerFrom: 0, hasEmbed: true, hasHead: false });
      expect(plan.at(-1)).toMatchObject({ layerTo: m.config.layers, hasEmbed: false, hasHead: true });
      expect(plan.map((s) => s.layerTo - s.layerFrom)).toEqual(m.stageLayers);
      expect(m.stageDownloadBytes).toHaveLength(plan.length);
    }
    const c = QWEN3_1_7B.config;
    // q + o + k/v + mlp projections
    expect(layerMacs(c)).toBe(2048 * 2048 + 2048 * 2048 + 2 * 2048 * 1024 + 3 * 2048 * 6144);
    const [s0, , , s3] = stagePlan(QWEN3_1_7B);
    expect(stageUnits(c, s3, 1) - stageUnits(c, s0, 1)).toBe(Math.round((2048 * 151936) / 1_048_576)); // the head's projection
    // A 256 MB adapter cannot hold the Q8 embedding of the end stages but fits a middle stage.
    expect(nodeFitsStage(QWEN3_1_7B, s0, 256 * 1024 * 1024)).toBe(false);
    expect(nodeFitsStage(QWEN3_1_7B, stagePlan(QWEN3_1_7B)[1], 256 * 1024 * 1024)).toBe(true);
    expect(nodeFitsStage(QWEN3_4B, stagePlan(QWEN3_4B)[0], 1024 * 1024 * 1024)).toBe(true);
  });

  it("single-tab variants are one stage with embedding and head, share weights with the sharded entry, and are gated by total memory", () => {
    for (const [solo, sharded] of [
      [QWEN3_0_6B_SOLO, QWEN3_0_6B],
      [QWEN3_1_7B_SOLO, QWEN3_1_7B],
    ] as const) {
      expect(isSingleTab(solo)).toBe(true);
      expect(isSingleTab(sharded)).toBe(false);
      const plan = stagePlan(solo);
      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({ stage: 0, layerFrom: 0, layerTo: solo.config.layers, hasEmbed: true, hasHead: true });
      expect([solo.repo, solo.weightsFile, solo.config]).toEqual([sharded.repo, sharded.weightsFile, sharded.config]);
      // One lap through the whole model costs the same units as all sharded stages together.
      const whole = stageUnits(solo.config, plan[0], 1);
      const parts = stagePlan(sharded).reduce((a, s) => a + stageUnits(sharded.config, s, 1), 0);
      expect(Math.abs(whole - parts)).toBeLessThanOrEqual(stagePlan(sharded).length);
    }
    const gb = 1024 * 1024 * 1024;
    const [solo17] = stagePlan(QWEN3_1_7B_SOLO);
    // A 1 GB adapter fits the sharded end stage but is not asked to hold the whole 1.7B model (1.14 GB of weights against 0.5 GB schedulable).
    expect(nodeFitsStage(QWEN3_1_7B, stagePlan(QWEN3_1_7B)[0], gb)).toBe(true);
    expect(nodeFitsStage(QWEN3_1_7B_SOLO, solo17, gb)).toBe(false);
    expect(nodeFitsStage(QWEN3_1_7B_SOLO, solo17, 2.5 * gb)).toBe(true);
    expect(nodeFitsStage(QWEN3_0_6B_SOLO, stagePlan(QWEN3_0_6B_SOLO)[0], 1.1 * gb)).toBe(false);
    expect(nodeFitsStage(QWEN3_0_6B_SOLO, stagePlan(QWEN3_0_6B_SOLO)[0], 1.3 * gb)).toBe(true);
    // Ladder: single-tab 1.7B is filled first; preference serves the largest model, single-tab before sharded at the same size.
    expect(MODEL_LADDER[0]).toBe(QWEN3_1_7B_SOLO);
    expect(MODEL_PREFERENCE.map((m) => m.id)).toEqual(["qwen3-4b", "qwen3-1.7b-solo", "qwen3-1.7b", "qwen3-0.6b-solo", "qwen3-0.6b"]);
  });
});

describe("gguf", () => {
  it("f16 round-trips", () => {
    for (const v of [0, 1, -2.5, 0.1, 65504, 1e-5, -0.333]) expect(f16Bits(f32ToF16Bits(v))).toBeCloseTo(v, v === 65504 ? -2 : 3);
  });

  it("dequantises Q8_0 and Q4_0 blocks and the GPU repack matches", () => {
    // Q8_0 block: scale 0.5, values 1..32 (int8)
    const q8 = new Uint8Array(34);
    new DataView(q8.buffer).setUint16(0, f32ToF16Bits(0.5), true);
    for (let i = 0; i < 32; i++) q8[2 + i] = (i + 1) & 0xff;
    const info8: GgufTensorInfo = { name: "t", shape: [1, 32], ggmlType: GGML_Q8_0, nElems: 32, start: 0, end: 34 };
    const f8 = dequantToF32(info8, q8);
    expect(f8[0]).toBeCloseTo(0.5);
    expect(f8[31]).toBeCloseTo(16);
    const e8 = toWeightEntry(info8, q8);
    expect(e8.kind).toBe("q8");
    expect(Array.from(entryToF32(e8))).toEqual(Array.from(f8));

    // Q4_0 block: scale 2, nibble i → low = i, high = 15 - i
    const q4 = new Uint8Array(18);
    new DataView(q4.buffer).setUint16(0, f32ToF16Bits(2), true);
    for (let i = 0; i < 16; i++) q4[2 + i] = (i & 0xf) | (((15 - i) & 0xf) << 4);
    const info4: GgufTensorInfo = { name: "t", shape: [1, 32], ggmlType: GGML_Q4_0, nElems: 32, start: 0, end: 18 };
    const f4 = dequantToF32(info4, q4);
    expect(f4[0]).toBe(2 * (0 - 8));
    expect(f4[15]).toBe(2 * (15 - 8));
    expect(f4[16]).toBe(2 * (15 - 8));
    expect(f4[31]).toBe(2 * (0 - 8));
    const e4 = toWeightEntry(info4, q4);
    expect(e4.kind).toBe("q4");
    expect(Array.from(entryToF32(e4))).toEqual(Array.from(f4));
  });

  it("parses a minimal header", () => {
    // magic, version 3, 1 tensor, 1 kv (general.alignment u32 = 32), tensor "w" dims [4,2] f32 offset 0
    const parts: number[] = [];
    const u32 = (v: number) => parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
    const u64 = (v: number) => {
      u32(v);
      u32(0);
    };
    const str = (s: string) => {
      u64(s.length);
      for (const c of new TextEncoder().encode(s)) parts.push(c);
    };
    u32(0x46554747);
    u32(3);
    u64(1);
    u64(1);
    str("general.alignment");
    u32(4);
    u32(32);
    str("w");
    u32(2);
    u64(4);
    u64(2);
    u32(0);
    u64(0);
    const h = parseGgufHeader(new Uint8Array(parts).buffer);
    expect(h.tensors.w.shape).toEqual([2, 4]);
    expect(h.tensors.w.start % 32).toBe(0);
    expect(h.tensors.w.end - h.tensors.w.start).toBe(32);
  });
});

describe.skipIf(!HAVE_WEIGHTS)("Qwen3-0.6B on real weights (CPU reference)", () => {
  // Loaded lazily: vitest evaluates skipped describe bodies during collection.
  let loaded: { header: ReturnType<typeof parseGgufHeader>; t: ReturnType<typeof entriesFromBuffer>; tok: Tokenizer } | undefined;
  const load = () => {
    if (!loaded) {
      const file = readFileSync(path.join(DIR, "model.gguf"));
      const buf = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
      const header = parseGgufHeader(buf);
      loaded = { header, t: entriesFromBuffer(buf, header), tok: new Tokenizer(JSON.parse(readFileSync(path.join(DIR, "tokenizer.json"), "utf8"))) };
    }
    return loaded;
  };
  const cfg = QWEN3_0_6B.config;

  it("header matches the model config", () => {
    const { header } = load();
    expect(header.meta["qwen3.block_count"]).toBe(cfg.layers);
    expect(header.meta["qwen3.embedding_length"]).toBe(cfg.hidden);
    expect(header.meta["qwen3.attention.head_count"]).toBe(cfg.heads);
    expect(header.meta["qwen3.attention.head_count_kv"]).toBe(cfg.kvHeads);
    expect(header.meta["qwen3.attention.key_length"]).toBe(cfg.headDim);
    expect(header.tensors["token_embd.weight"].shape).toEqual([cfg.vocab, cfg.hidden]);
  });

  it("tokenizer round-trips text and matches known ids", () => {
    const { tok } = load();
    const s = "Hello world! The year is 2024, café ☕. Don't stop.";
    const ids = tok.encode(s);
    expect(tok.decode(ids)).toBe(s);
    expect(tok.tokenId("<|im_start|>")).toBe(151644);
    expect(tok.tokenId("<|im_end|>")).toBe(151645);
    expect(tok.encode("<|im_start|>user\nhi<|im_end|>")).toEqual([151644, ...tok.encode("user\nhi"), 151645]);
    // Qwen's split keeps digits apart and attaches a leading space to words.
    expect(tok.encode("2024")).toHaveLength(4);
    const sd = new StreamDecoder(tok);
    expect(ids.map((i) => sd.push(i)).join("") + sd.flush()).toBe(s);
  });

  it("answers a factual prompt greedily through all 28 layers", () => {
    const { t, tok } = load();
    const prompt = chatPrompt([{ role: "user", content: "What is the capital of France? Answer in one word." }], { noThink: true });
    const ids = tok.encode(prompt);
    const layers = Array.from({ length: cfg.layers }, (_, i) => layerWeightsFrom(t, i));
    const kvs = layers.map(() => createKv(cfg, 64));
    const embedE = t.get("token_embd.weight");
    const normW = entryToF32(t.get("output_norm.weight"));
    const x = embed(embedE, cfg.hidden, ids);
    const positions = ids.map((_, i) => i);
    stageForward(cfg, layers, kvs, x, ids.length, positions);
    const out: number[] = [];
    let last = x.subarray((ids.length - 1) * cfg.hidden);
    for (let step = 0; step < 5; step++) {
      const logits = finalLogits(cfg, normW, embedE, last);
      const next = topK(logits, 1).ids[0];
      if (cfg.eos.includes(next)) break;
      out.push(next);
      const row = embed(embedE, cfg.hidden, [next]);
      stageForward(cfg, layers, kvs, row, 1, [ids.length + step]);
      last = row;
    }
    const text = tok.decode(out);
    expect(text.toLowerCase()).toContain("paris");
  }, 300_000);
});
