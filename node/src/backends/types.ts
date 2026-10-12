import type { Backend as BackendKind, ImportOffer, JobPayload } from "../../protocol";

export interface GenerateResult {
  content: string;
  finishReason: "stop" | "length" | "cancelled";
  usage: { prompt: number; completion: number };
}

/**
 * An inference backend the agent can drive. `generate` streams deltas through `onDelta` and
 * resolves with the full text; the agent hashes the text and reports it.
 */
export interface InferenceBackend {
  readonly kind: BackendKind;
  /** Allowlisted model ids this backend can serve on this machine. */
  supportedModels(): string[];
  loadedModels(): string[];
  /** Load (or confirm) a model. Resolves `true` when a load actually happened. */
  ensureLoaded(model: string, signal: AbortSignal): Promise<boolean>;
  /** Optional: begin loading a model in the background before any job asks for it. */
  prewarm?(model?: string): void;
  /** Optional: re-read what the server serves (after the imported-model table changed). */
  discover?(): Promise<string[]>;
  /** Optional: fetch imported models the coordinator offered. Resolves with the ids now served. Only Ollama can pull on its own. */
  pullImports?(offers: ImportOffer[], log: (line: string) => void): Promise<string[]>;
  generate(job: JobPayload, onDelta: (delta: string, tokens: number) => void, signal: AbortSignal): Promise<GenerateResult>;
  /** Stop everything; containers down, memory freed. */
  shutdown(): Promise<void>;
}
