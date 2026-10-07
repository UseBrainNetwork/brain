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
];

const byId = new Map(MODEL_ALLOWLIST.map((m) => [m.id, m]));

export const modelSpec = (id: string): ModelSpec | undefined => byId.get(id);
export const isAllowedModel = (id: string) => byId.has(id);
/** Ids a node may advertise, in list order, dropping anything not allowlisted. */
export const filterAllowed = (ids: readonly string[]) => MODEL_ALLOWLIST.filter((m) => ids.includes(m.id)).map((m) => m.id);
