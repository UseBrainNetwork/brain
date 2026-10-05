/** Shared OpenAI-compatible request/response shapes used by the gateway and upstream client. */
import type { ChatMessage, ChatOptions, ToolCall } from "@/domain/chat";

export type { ChatMessage, ToolCall } from "@/domain/chat";

export interface ChatRequest extends ChatOptions {
  model: string;
  /** Concrete upstream model id to run (per-mode choice). Falls back to the provider's configured default. */
  upstreamModel?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface ChatResult {
  content: string;
  toolCalls?: ToolCall[];
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
