/** Shared OpenAI-compatible request/response shapes used by the gateway and upstream client. */
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
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** Upstream-reported USD for the request when the vendor sends it (OpenRouter does). */
    cost?: number | null;
  };
  upstreamModel: string;
}
