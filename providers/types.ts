export type ExecutionTarget = "BROWSER_NETWORK" | "CLOUD_FALLBACK" | "EXTERNAL_MODEL_PROVIDER";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface ChatResult {
  content: string;
  finishReason: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  upstreamModel: string;
}

/** What a provider can offer for a given model right now. Inputs to the router. */
export interface Candidate {
  target: ExecutionTarget;
  providerId: string;
  compatible: boolean;
  available: boolean;
  /** Reasons a candidate was excluded or penalized — surfaced in the decision trace. */
  notes: string[];
  estLatencyMs: number;
  /** USD per 1M tokens, null when unknown. */
  costPer1M: number | null;
  /** 0..1 */
  reliability: number;
  /** 0..1 free capacity */
  capacity: number;
}

export interface InferenceProvider {
  id: string;
  target: ExecutionTarget;
  evaluate(model: string): Promise<Candidate>;
  complete(req: ChatRequest): Promise<ChatResult>;
  /** Upstream OpenAI-style SSE body. Optional: providers without it are skipped for streaming requests. */
  stream?(req: ChatRequest): Promise<ReadableStream<Uint8Array>>;
}
