import type { Backend as BackendKind, JobPayload } from "../../protocol";

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
  generate(job: JobPayload, onDelta: (delta: string, tokens: number) => void, signal: AbortSignal): Promise<GenerateResult>;
  /** Stop everything; containers down, memory freed. */
  shutdown(): Promise<void>;
}
