/**
 * Models the browser network can run: the Qwen3 dense family (Apache-2.0), read straight from
 * public GGUF files on the Hugging Face CDN by range request. Each node downloads only the
 * tensors of its pipeline stage.
 *
 * Split: stage 0 holds the token embedding and the first layers; the last stage holds the final
 * layers, the final norm and the (tied) output projection and returns top-k logits. The gateway
 * holds no weights at all: it tokenizes, drives the pipeline, samples and verifies. Every stage,
 * including the ends, is run on two nodes and compared, so no node is trusted with the vocabulary
 * projection alone.
 */

export interface LlamaConfig {
  hidden: number;
  intermediate: number;
  layers: number;
  heads: number;
  kvHeads: number;
  headDim: number;
  vocab: number;
  eps: number;
  ropeTheta: number;
  maxPositions: number;
  bos: number | null;
  eos: number[];
  /** Qwen3: RMSNorm over each query/key head before RoPE. */
  qkNorm: boolean;
}

export interface NetworkModel {
  id: string;
  label: string;
  /** Short family name shown in pickers. */
  family: string;
  params: string;
  repo: string;
  revision: string;
  weightsFile: string;
  /** Repository + file of the Hugging Face tokenizer.json (the GGUF carries one too, but the JSON is smaller to parse in a serverless function). */
  tokenizerRepo: string;
  tokenizerFile: string;
  license: string;
  quant: string;
  config: LlamaConfig;
  /** Layers per pipeline stage, in order. */
  stageLayers: number[];
  /** Approximate bytes a node downloads per stage (file bytes). */
  stageDownloadBytes: number[];
  /** Approximate GPU bytes per stage after repacking (the embedding is requantised to Q8). */
  stageGpuBytes: number[];
  /** Maximum context the network serves per session (KV cache memory on the smallest node class). */
  maxContext: number;
  /** Prompt template adds an empty think block so the model answers directly (Qwen3 `enable_thinking=false`). */
  noThink: boolean;
  /** Order in the model ladder: capacity is filled lowest `tier` first. */
  tier: number;
}

const QWEN3_BASE: Omit<LlamaConfig, "hidden" | "intermediate" | "layers" | "heads"> = {
  headDim: 128,
  kvHeads: 8,
  vocab: 151936,
  eps: 1e-6,
  ropeTheta: 1_000_000,
  maxPositions: 40960,
  bos: null,
  eos: [151645, 151643],
  qkNorm: true,
};

export const QWEN3_0_6B: NetworkModel = {
  id: "qwen3-0.6b",
  label: "Qwen3 0.6B",
  family: "Qwen3",
  params: "0.6B",
  repo: "Qwen/Qwen3-0.6B-GGUF",
  revision: "main",
  weightsFile: "Qwen3-0.6B-Q8_0.gguf",
  tokenizerRepo: "Qwen/Qwen3-0.6B",
  tokenizerFile: "tokenizer.json",
  license: "Apache-2.0",
  quant: "Q8_0",
  config: { ...QWEN3_BASE, hidden: 1024, intermediate: 3072, layers: 28, heads: 16 },
  stageLayers: [5, 18, 5],
  stageDownloadBytes: [249e6, 301e6, 249e6],
  stageGpuBytes: [249e6, 301e6, 249e6],
  maxContext: 1024,
  noThink: true,
  tier: 2,
};

export const QWEN3_1_7B: NetworkModel = {
  id: "qwen3-1.7b",
  label: "Qwen3 1.7B",
  family: "Qwen3",
  params: "1.7B",
  repo: "unsloth/Qwen3-1.7B-GGUF",
  revision: "main",
  weightsFile: "Qwen3-1.7B-Q4_0.gguf",
  tokenizerRepo: "Qwen/Qwen3-1.7B",
  tokenizerFile: "tokenizer.json",
  license: "Apache-2.0",
  quant: "Q4_0",
  config: { ...QWEN3_BASE, hidden: 2048, intermediate: 6144, layers: 28, heads: 16 },
  stageLayers: [3, 11, 11, 3],
  stageDownloadBytes: [342e6, 319e6, 319e6, 342e6],
  stageGpuBytes: [418e6, 319e6, 319e6, 418e6],
  maxContext: 1024,
  noThink: true,
  tier: 0,
};

export const QWEN3_4B: NetworkModel = {
  id: "qwen3-4b",
  label: "Qwen3 4B",
  family: "Qwen3",
  params: "4B",
  repo: "unsloth/Qwen3-4B-GGUF",
  revision: "main",
  weightsFile: "Qwen3-4B-Q4_0.gguf",
  tokenizerRepo: "Qwen/Qwen3-4B",
  tokenizerFile: "tokenizer.json",
  license: "Apache-2.0",
  quant: "Q4_0",
  config: { ...QWEN3_BASE, hidden: 2560, intermediate: 9728, layers: 36, heads: 32 },
  stageLayers: [2, 8, 8, 8, 8, 2],
  stageDownloadBytes: [433e6, 454e6, 454e6, 454e6, 454e6, 433e6],
  stageGpuBytes: [527e6, 454e6, 454e6, 454e6, 454e6, 527e6],
  maxContext: 1024,
  noThink: true,
  tier: 1,
};

export const NETWORK_MODELS: Record<string, NetworkModel> = {
  [QWEN3_1_7B.id]: QWEN3_1_7B,
  [QWEN3_4B.id]: QWEN3_4B,
  [QWEN3_0_6B.id]: QWEN3_0_6B,
};

/** Capacity is filled in this order (see `assignShard`). */
export const MODEL_LADDER: NetworkModel[] = Object.values(NETWORK_MODELS).sort((a, b) => a.tier - b.tier);

/** Preference when a chat does not name a model: the largest one the network can serve. */
export const MODEL_PREFERENCE: NetworkModel[] = [QWEN3_4B, QWEN3_1_7B, QWEN3_0_6B];

export const DEFAULT_NETWORK_MODEL = QWEN3_1_7B;

export function hubUrl(m: NetworkModel, file: string): string {
  return `https://huggingface.co/${m.repo}/resolve/${m.revision}/${file}`;
}

export function tokenizerUrl(m: NetworkModel): string {
  return `https://huggingface.co/${m.tokenizerRepo}/resolve/${m.revision}/${m.tokenizerFile}`;
}

export interface StageSpan {
  stage: number;
  layerFrom: number;
  /** Exclusive. */
  layerTo: number;
  /** Holds the token embedding and turns token ids into the first hidden state. */
  hasEmbed: boolean;
  /** Holds the final norm + output projection and returns top-k logits instead of a hidden state. */
  hasHead: boolean;
}

export function stagePlan(m: NetworkModel): StageSpan[] {
  const out: StageSpan[] = [];
  let from = 0;
  m.stageLayers.forEach((n, i) => {
    out.push({ stage: i, layerFrom: from, layerTo: from + n, hasEmbed: i === 0, hasHead: i === m.stageLayers.length - 1 });
    from += n;
  });
  if (from !== m.config.layers) throw new Error(`stage plan for ${m.id} covers ${from} of ${m.config.layers} layers`);
  return out;
}

/** Multiply-accumulates for one token through one layer (projections + MLP; attention over the cache excluded). */
export function layerMacs(c: LlamaConfig): number {
  const q = c.hidden * c.heads * c.headDim;
  const o = c.heads * c.headDim * c.hidden;
  const kv = 2 * c.hidden * c.kvHeads * c.headDim;
  const mlp = 3 * c.hidden * c.intermediate;
  return q + o + kv + mlp;
}

/** MACs for one token through a stage, including the output projection on the head stage. */
export function stageMacs(c: LlamaConfig, span: Pick<StageSpan, "layerFrom" | "layerTo" | "hasHead">): number {
  return layerMacs(c) * (span.layerTo - span.layerFrom) + (span.hasHead ? c.hidden * c.vocab : 0);
}

/** Compute units (1 unit ≈ 2^20 MACs, same scale as `workloadUnits`) for `tokens` through a stage. */
export function stageUnits(c: LlamaConfig, span: Pick<StageSpan, "layerFrom" | "layerTo" | "hasHead">, tokens: number): number {
  return Math.max(1, Math.round((stageMacs(c, span) * tokens) / 1_048_576));
}

/** The largest single GPU buffer a stage needs (the Q8 embedding / head on the end stages). */
export function stageMaxBufferBytes(m: NetworkModel, span: StageSpan): number {
  const c = m.config;
  const embedQ8 = span.hasEmbed || span.hasHead ? c.vocab * c.hidden * (34 / 32) : 0;
  const ffn = c.hidden * c.intermediate * (m.quant === "Q8_0" ? 34 / 32 : 18 / 32);
  return Math.max(embedQ8, ffn);
}

/** Can a node with this adapter buffer limit hold the given stage? */
export function nodeFitsStage(m: NetworkModel, span: StageSpan, maxBufferBytes: number): boolean {
  if (!maxBufferBytes) return false;
  return maxBufferBytes >= stageMaxBufferBytes(m, span) * 1.1;
}
