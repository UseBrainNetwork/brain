import "server-only";
import { inferenceModels } from "@/services/mock/mockData";
import type { ChatMessage, ChatRequest } from "@/providers/types";

/**
 * Brain Gateway: request validation and OpenAI-shaped framing for /v1.
 * Routing, execution, fallback and receipts live in engine/orders.ts (BRAIN AUTO).
 */

export class GatewayError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const MODEL_IDS = new Set(inferenceModels.map((m) => m.id));
const MAX_MESSAGES = 40;
const MAX_CHARS = 24_000;

export function validateChat(body: unknown): ChatRequest {
  if (!body || typeof body !== "object") throw new GatewayError(400, "invalid_request", "Body must be a JSON object.");
  const b = body as Record<string, unknown>;
  const model = typeof b.model === "string" ? b.model : "brain/auto";
  if (!MODEL_IDS.has(model)) throw new GatewayError(404, "model_not_found", `Unknown model '${model}'.`);
  if (!Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > MAX_MESSAGES) {
    throw new GatewayError(400, "invalid_request", `messages must be an array of 1–${MAX_MESSAGES} items.`);
  }
  let chars = 0;
  const messages: ChatMessage[] = b.messages.map((m) => {
    const role = (m as ChatMessage)?.role;
    const content = (m as ChatMessage)?.content;
    if (!["system", "user", "assistant"].includes(role) || typeof content !== "string") {
      throw new GatewayError(400, "invalid_request", "Each message needs a role and string content.");
    }
    chars += content.length;
    return { role, content };
  });
  if (chars > MAX_CHARS) throw new GatewayError(413, "too_large", `Total content exceeds ${MAX_CHARS} characters.`);
  const max_tokens = Math.min(2048, Math.max(1, Number(b.max_tokens) || 512));
  const temperature = Math.min(2, Math.max(0, Number(b.temperature ?? 0.4)));
  return { model, messages, max_tokens, temperature, stream: b.stream === true };
}

/**
 * Re-frames an upstream OpenAI SSE stream as ours: every chunk gets our id and model name, so
 * upstream identifiers never reach the client. The upstream `[DONE]` is dropped so the caller
 * can append its own trailer (the `brain` event) before closing. Non-JSON lines pass through.
 */
export function reframeStream(upstream: ReadableStream<Uint8Array>, id: string, model: string, created: number): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  const line = (l: string): string | null => {
    if (!l.startsWith("data:")) return l;
    const payload = l.slice(5).trim();
    if (payload === "[DONE]") return null;
    try {
      const j = JSON.parse(payload) as { choices?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null };
      // Whitelist: upstream vendor fields (provider names, upstream cost, tiers) never reach the client.
      const usage = j.usage && typeof j.usage.total_tokens === "number" ? { prompt_tokens: j.usage.prompt_tokens ?? 0, completion_tokens: j.usage.completion_tokens ?? 0, total_tokens: j.usage.total_tokens } : undefined;
      return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: j.choices ?? [], ...(usage ? { usage } : {}) })}`;
    } catch {
      return l;
    }
  };
  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        const out = lines.map(line).filter((l): l is string => l != null);
        if (out.length) ctl.enqueue(enc.encode(out.join("\n") + "\n"));
      },
      flush(ctl) {
        const last = buf ? line(buf) : null;
        if (last) ctl.enqueue(enc.encode(last + "\n"));
      },
    }),
  );
}

export function listModels() {
  return {
    object: "list",
    data: inferenceModels.map((m) => ({ id: m.id, object: "model", owned_by: "brain", context_length: m.context, status: m.status })),
  };
}

/** Public API keys. If none configured the API is open but rate limited. */
export function authorizeApiKey(key: string | null): boolean {
  const keys = (process.env.BRAIN_API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0) return true;
  return key != null && keys.includes(key);
}
