import "server-only";
import type { Candidate, ChatRequest, ChatResult, ExecutionTarget, InferenceProvider } from "./types";

interface Options {
  id: string;
  target: ExecutionTarget;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  estLatencyMs: number;
  costPer1M: number | null;
  reliability: number;
}

/**
 * Any OpenAI-compatible upstream (OpenAI, OpenRouter, Together, Groq, self-hosted vLLM).
 * Credentials come from server env only and never reach the client.
 */
export class OpenAICompatibleProvider implements InferenceProvider {
  readonly id: string;
  readonly target: ExecutionTarget;
  constructor(private o: Options) {
    this.id = o.id;
    this.target = o.target;
  }

  private get configured() {
    return Boolean(this.o.baseUrl && this.o.apiKey && this.o.model);
  }

  async evaluate(model: string): Promise<Candidate> {
    const notes: string[] = [];
    if (!this.configured) notes.push("not configured (set env credentials)");
    return {
      target: this.target,
      providerId: this.id,
      compatible: model.startsWith("brain/") && model !== "brain/embed",
      available: this.configured,
      notes,
      estLatencyMs: this.o.estLatencyMs,
      costPer1M: this.o.costPer1M,
      reliability: this.o.reliability,
      capacity: 1,
    };
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
        body: JSON.stringify({ model: this.o.model, messages: req.messages, max_tokens: req.max_tokens, temperature: req.temperature, stream: true }),
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
        }),
      });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const j = await r.json();
      const choice = j.choices?.[0];
      return {
        content: String(choice?.message?.content ?? ""),
        finishReason: String(choice?.finish_reason ?? "stop"),
        usage: {
          prompt_tokens: j.usage?.prompt_tokens ?? 0,
          completion_tokens: j.usage?.completion_tokens ?? 0,
          total_tokens: j.usage?.total_tokens ?? 0,
        },
        upstreamModel: String(j.model ?? this.o.model),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
