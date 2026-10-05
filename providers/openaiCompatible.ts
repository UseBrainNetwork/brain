import "server-only";
import type { ChatRequest, ChatResult, ToolCall } from "./types";

/** Tool / format options forwarded to the upstream exactly as the caller sent them. */
const passthrough = (req: ChatRequest) => ({
  ...(req.tools?.length ? { tools: req.tools } : {}),
  ...(req.tool_choice != null && req.tools?.length ? { tool_choice: req.tool_choice } : {}),
  ...(req.response_format ? { response_format: req.response_format } : {}),
  ...(req.stop?.length ? { stop: req.stop } : {}),
});

interface Options {
  id: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/**
 * Thin client for any OpenAI-compatible upstream (OpenAI, OpenRouter, Together, Groq, self-hosted
 * vLLM). Credentials come from server env only and never reach the client. Routing, estimates and
 * receipts live in engine/providers.ts; this class only speaks HTTP.
 */
export class OpenAICompatibleProvider {
  readonly id: string;
  constructor(private o: Options) {
    this.id = o.id;
  }

  async stream(req: ChatRequest): Promise<ReadableStream<Uint8Array>> {
    const ctrl = new AbortController();
    // Time to first byte only; once streaming, the client connection governs lifetime.
    const timer = setTimeout(() => ctrl.abort(), 45_000);
    try {
      const r = await fetch(`${this.o.baseUrl!.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({ model: this.o.model, messages: req.messages, max_tokens: req.max_tokens, temperature: req.temperature, ...passthrough(req), stream: true, stream_options: { include_usage: true } }),
      });
      if (!r.ok || !r.body) throw new Error(`upstream ${r.status}`);
      return r.body;
    } finally {
      clearTimeout(timer);
    }
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45_000);
    try {
      const r = await fetch(`${this.o.baseUrl!.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({
          model: this.o.model,
          messages: req.messages,
          max_tokens: req.max_tokens,
          temperature: req.temperature,
          ...passthrough(req),
        }),
      });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const j = await r.json();
      const choice = j.choices?.[0];
      const toolCalls = Array.isArray(choice?.message?.tool_calls) ? (choice.message.tool_calls as ToolCall[]).filter((t) => t && t.type === "function" && t.function?.name).map((t) => ({ id: String(t.id), type: "function" as const, function: { name: String(t.function.name), arguments: String(t.function.arguments ?? "") } })) : undefined;
      return {
        content: String(choice?.message?.content ?? ""),
        toolCalls: toolCalls?.length ? toolCalls : undefined,
        finishReason: String(choice?.finish_reason ?? (toolCalls?.length ? "tool_calls" : "stop")),
        usage: {
          prompt_tokens: j.usage?.prompt_tokens ?? 0,
          completion_tokens: j.usage?.completion_tokens ?? 0,
          total_tokens: j.usage?.total_tokens ?? 0,
          cost: typeof j.usage?.cost === "number" ? j.usage.cost : null,
        },
        upstreamModel: String(j.model ?? this.o.model),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
