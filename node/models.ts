/**
 * Workload allowlist. A Brain Node will only launch what is listed here, with exactly these
 * images and arguments; the coordinator will only route model ids that are listed here. Nothing a
 * developer or a node operator sends can add to this list at runtime.
 *
 * Minimum VRAM figures are the published weights size plus KV-cache headroom at the given context,
 * rounded up. They gate routing (a node reporting less VRAM is never selected) and are shown on
 * /models as the requirement, not as a measurement.
 */

export type ComputeClass = "EDGE" | "CONSUMER" | "PRO" | "DATACENTER";

export interface ModelSpec {
  /** Public id developers send as `model`. */
  id: string;
  name: string;
  /** Hugging Face repository the vLLM backend serves. */
  hf: string;
  params: string;
  context: number;
  minVramMb: number;
  /** Compute classes expected to run it at interactive speed. Informational. */
  classes: ComputeClass[];
  license: string;
  /** Mock-only models never leave the mock backend and are always labelled as such. */
  mock?: boolean;
  /** Extra vLLM args. Images and ports are fixed in node/src/backends/vllm.ts. */
  vllmArgs?: string[];
}

export const MODEL_ALLOWLIST: readonly ModelSpec[] = [
  {
    id: "brain/mock",
    name: "Mock (development)",
    hf: "",
    params: "0",
    context: 8192,
    minVramMb: 0,
    classes: ["EDGE", "CONSUMER", "PRO", "DATACENTER"],
    license: "n/a",
    mock: true,
  },
  { id: "qwen/qwen2.5-1.5b-instruct", name: "Qwen2.5 1.5B Instruct", hf: "Qwen/Qwen2.5-1.5B-Instruct", params: "1.5B", context: 32768, minVramMb: 6_000, classes: ["CONSUMER", "PRO", "DATACENTER"], license: "Apache-2.0" },
  { id: "qwen/qwen2.5-3b-instruct", name: "Qwen2.5 3B Instruct", hf: "Qwen/Qwen2.5-3B-Instruct", params: "3B", context: 32768, minVramMb: 10_000, classes: ["CONSUMER", "PRO", "DATACENTER"], license: "Qwen Research" },
  { id: "qwen/qwen2.5-7b-instruct", name: "Qwen2.5 7B Instruct", hf: "Qwen/Qwen2.5-7B-Instruct", params: "7B", context: 32768, minVramMb: 20_000, classes: ["PRO", "DATACENTER"], license: "Apache-2.0" },
  { id: "qwen/qwen2.5-7b-instruct-awq", name: "Qwen2.5 7B Instruct (AWQ 4-bit)", hf: "Qwen/Qwen2.5-7B-Instruct-AWQ", params: "7B", context: 32768, minVramMb: 10_000, classes: ["CONSUMER", "PRO", "DATACENTER"], license: "Apache-2.0", vllmArgs: ["--quantization", "awq"] },
  { id: "mistralai/mistral-7b-instruct-v0.3", name: "Mistral 7B Instruct v0.3", hf: "mistralai/Mistral-7B-Instruct-v0.3", params: "7B", context: 32768, minVramMb: 20_000, classes: ["PRO", "DATACENTER"], license: "Apache-2.0" },
  { id: "meta-llama/llama-3.1-8b-instruct", name: "Llama 3.1 8B Instruct", hf: "meta-llama/Llama-3.1-8B-Instruct", params: "8B", context: 32768, minVramMb: 20_000, classes: ["PRO", "DATACENTER"], license: "Llama 3.1 Community (gated; node needs HF_TOKEN)" },
  // Larger models an operator pins on purpose. Nobody is routed these unless they serve them; the
  // /models page shows how often each was asked for and went unserved, so operators can see where to compete.
  // Plain ids are the model at the precision the node runs (Ollama/llama.cpp/mlx quantize as they like);
  // "-awq" ids are the vLLM 4-bit builds with their own VRAM floor, as with the 7B pair above.
  { id: "qwen/qwen2.5-14b-instruct", name: "Qwen2.5 14B Instruct", hf: "Qwen/Qwen2.5-14B-Instruct", params: "14B", context: 32768, minVramMb: 34_000, classes: ["PRO", "DATACENTER"], license: "Apache-2.0" },
  { id: "qwen/qwen2.5-14b-instruct-awq", name: "Qwen2.5 14B Instruct (AWQ 4-bit)", hf: "Qwen/Qwen2.5-14B-Instruct-AWQ", params: "14B", context: 32768, minVramMb: 14_000, classes: ["CONSUMER", "PRO", "DATACENTER"], license: "Apache-2.0", vllmArgs: ["--quantization", "awq"] },
  { id: "qwen/qwen2.5-32b-instruct", name: "Qwen2.5 32B Instruct", hf: "Qwen/Qwen2.5-32B-Instruct", params: "32B", context: 32768, minVramMb: 72_000, classes: ["DATACENTER"], license: "Apache-2.0" },
  { id: "qwen/qwen2.5-32b-instruct-awq", name: "Qwen2.5 32B Instruct (AWQ 4-bit)", hf: "Qwen/Qwen2.5-32B-Instruct-AWQ", params: "32B", context: 32768, minVramMb: 24_000, classes: ["PRO", "DATACENTER"], license: "Apache-2.0", vllmArgs: ["--quantization", "awq"] },
  { id: "qwen/qwen2.5-coder-32b-instruct", name: "Qwen2.5 Coder 32B Instruct", hf: "Qwen/Qwen2.5-Coder-32B-Instruct", params: "32B", context: 32768, minVramMb: 72_000, classes: ["DATACENTER"], license: "Apache-2.0" },
  { id: "qwen/qwen2.5-coder-32b-instruct-awq", name: "Qwen2.5 Coder 32B Instruct (AWQ 4-bit)", hf: "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ", params: "32B", context: 32768, minVramMb: 24_000, classes: ["PRO", "DATACENTER"], license: "Apache-2.0", vllmArgs: ["--quantization", "awq"] },
  { id: "qwen/qwen2.5-72b-instruct", name: "Qwen2.5 72B Instruct", hf: "Qwen/Qwen2.5-72B-Instruct", params: "72B", context: 32768, minVramMb: 150_000, classes: ["DATACENTER"], license: "Qwen (non-commercial above 100M MAU)" },
  { id: "qwen/qwen2.5-72b-instruct-awq", name: "Qwen2.5 72B Instruct (AWQ 4-bit)", hf: "Qwen/Qwen2.5-72B-Instruct-AWQ", params: "72B", context: 32768, minVramMb: 48_000, classes: ["DATACENTER"], license: "Qwen (non-commercial above 100M MAU)", vllmArgs: ["--quantization", "awq"] },
  { id: "deepseek-ai/deepseek-r1-distill-qwen-32b", name: "DeepSeek R1 Distill Qwen 32B", hf: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", params: "32B", context: 32768, minVramMb: 72_000, classes: ["DATACENTER"], license: "MIT" },
  { id: "deepseek-ai/deepseek-r1-distill-llama-8b", name: "DeepSeek R1 Distill Llama 8B", hf: "deepseek-ai/DeepSeek-R1-Distill-Llama-8B", params: "8B", context: 32768, minVramMb: 20_000, classes: ["PRO", "DATACENTER"], license: "MIT (Llama 3.1 Community for the base weights)" },
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B Instruct", hf: "meta-llama/Llama-3.3-70B-Instruct", params: "70B", context: 32768, minVramMb: 150_000, classes: ["DATACENTER"], license: "Llama 3.3 Community (gated; node needs HF_TOKEN)" },
];

const byId = new Map(MODEL_ALLOWLIST.map((m) => [m.id, m]));

export const modelSpec = (id: string): ModelSpec | undefined => byId.get(id);
export const isAllowedModel = (id: string) => byId.has(id);
/** Ids a node may advertise, in list order, dropping anything not allowlisted. */
export const filterAllowed = (ids: readonly string[]) => MODEL_ALLOWLIST.filter((m) => ids.includes(m.id)).map((m) => m.id);

/**
 * Local inference servers name models their own way: Ollama "qwen2.5:1.5b-instruct", llama.cpp
 * whatever alias the GGUF was started under ("Qwen2.5-1.5B-Instruct-Q4_K_M"), mlx-lm
 * "mlx-community/Qwen2.5-1.5B-Instruct-4bit". Stripped of separators and case they all contain the
 * allowlisted id's own name, so a served name maps to at most one allowlisted model. An operator
 * can still pin the mapping explicitly (BRAIN_NODE_MODEL_MAP); this is the fallback.
 */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export function matchServedModel(servedName: string): ModelSpec | undefined {
  const k = key(servedName);
  if (!k) return undefined;
  // Longest allowlisted name first so "qwen2.5-7b-instruct-awq" is not taken for "qwen2.5-7b-instruct".
  const candidates = MODEL_ALLOWLIST.filter((m) => !m.mock)
    .map((m) => ({ m, core: key(m.id.split("/").pop() ?? m.id) }))
    .sort((a, b) => b.core.length - a.core.length);
  return candidates.find((c) => c.core && k.includes(c.core))?.m;
}
