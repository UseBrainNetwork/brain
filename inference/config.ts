/**
 * Models the browser network can run. One entry today: SmolLM2-135M-Instruct (Apache-2.0,
 * Llama architecture). Weights are fetched straight from the Hugging Face CDN by range request;
 * each node downloads only the layers of its pipeline stage.
 *
 * The transformer layers run on contributor nodes. The token embedding, final norm and output
 * projection (tied to the embedding) run on the gateway, which also samples. That split keeps every
 * stage the same size and lets the gateway hold the only copy of the vocabulary projection.
 */

export interface LlamaConfig {
  hidden: number;
  intermediate: number;
  layers: number;
  heads: number;
  kvHeads: number;
  vocab: number;
  eps: number;
  ropeTheta: number;
  maxPositions: number;
  bos: number;
  eos: number[];
}

export interface NetworkModel {
  id: string;
  label: string;
  repo: string;
  revision: string;
  weightsFile: string;
  tokenizerFile: string;
  license: string;
  config: LlamaConfig;
  /** Pipeline stages; each holds `config.layers / stages` consecutive layers. */
  stages: number;
  /** Maximum context the network serves. Bounded by KV-cache memory on the smallest node class. */
  maxContext: number;
}

export const SMOLLM2_135M: NetworkModel = {
  id: "smollm2-135m-instruct",
  label: "SmolLM2 135M Instruct",
  repo: "HuggingFaceTB/SmolLM2-135M-Instruct",
  revision: "main",
  weightsFile: "model.safetensors",
  tokenizerFile: "tokenizer.json",
  license: "Apache-2.0",
  config: {
    hidden: 576,
    intermediate: 1536,
    layers: 30,
    heads: 9,
    kvHeads: 3,
    vocab: 49152,
    eps: 1e-5,
    ropeTheta: 100000,
    maxPositions: 8192,
    bos: 1,
    eos: [2, 0],
  },
  stages: 3,
  maxContext: 1024,
};

export const NETWORK_MODELS: Record<string, NetworkModel> = { [SMOLLM2_135M.id]: SMOLLM2_135M };

export const DEFAULT_NETWORK_MODEL = SMOLLM2_135M;

export function hubUrl(m: NetworkModel, file: string): string {
  return `https://huggingface.co/${m.repo}/resolve/${m.revision}/${file}`;
}

export interface StageSpan {
  stage: number;
  layerFrom: number;
  /** Exclusive. */
  layerTo: number;
}

export function stagePlan(m: NetworkModel): StageSpan[] {
  const per = Math.ceil(m.config.layers / m.stages);
  const out: StageSpan[] = [];
  for (let s = 0; s < m.stages; s++) {
    const from = s * per;
    const to = Math.min(m.config.layers, from + per);
    if (from >= to) break;
    out.push({ stage: s, layerFrom: from, layerTo: to });
  }
  return out;
}

/** Multiply-accumulates for one token through one layer (projections + MLP; attention over the cache excluded). */
export function layerMacs(c: LlamaConfig): number {
  const headDim = c.hidden / c.heads;
  const qo = 2 * c.hidden * c.hidden;
  const kv = 2 * c.hidden * c.kvHeads * headDim;
  const mlp = 3 * c.hidden * c.intermediate;
  return qo + kv + mlp;
}

/** Compute units (1 unit ≈ 2^20 MACs, same scale as `workloadUnits`) for `tokens` through `layers` layers. */
export function stageUnits(c: LlamaConfig, layers: number, tokens: number): number {
  return Math.max(1, Math.round((layerMacs(c) * layers * tokens) / 1_048_576));
}
