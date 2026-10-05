import "server-only";
import { inferenceModels } from "@/services/mock/mockData";
import type { ChatMessage, ChatRequest } from "@/providers/types";
import { chatChars, type ResponseFormat, type ToolChoice, type ToolDefinition } from "@/domain/chat";

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

const MAX_TOOLS = 64;
const MAX_TOOLS_CHARS = 64_000;
const ROLES = new Set(["system", "user", "assistant", "tool"]);

/** OpenAI allows `content` as a string or an array of parts; we accept text parts and join them. */
function textContent(c: unknown): string | null | undefined {
  if (c == null) return null;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const p of c) {
      if (p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string") parts.push((p as { text: string }).text);
      else return undefined;
    }
    return parts.join("\n");
  }
  return undefined;
}

function validateTools(raw: unknown): ToolDefinition[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_TOOLS) throw new GatewayError(400, "invalid_request", `tools must be an array of at most ${MAX_TOOLS} items.`);
  const tools: ToolDefinition[] = raw.map((t) => {
    const fn = (t as { function?: { name?: unknown; description?: unknown; parameters?: unknown; strict?: unknown } })?.function;
    if ((t as { type?: unknown })?.type !== "function" || !fn || typeof fn.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(fn.name)) {
      throw new GatewayError(400, "invalid_request", "Each tool needs type 'function' and a function.name of 1–64 [A-Za-z0-9_-] characters.");
    }
    if (fn.parameters != null && (typeof fn.parameters !== "object" || Array.isArray(fn.parameters))) throw new GatewayError(400, "invalid_request", `tool '${fn.name}': parameters must be a JSON Schema object.`);
    return {
      type: "function",
      function: {
        name: fn.name,
        ...(typeof fn.description === "string" ? { description: fn.description.slice(0, 1024) } : {}),
        ...(fn.parameters ? { parameters: fn.parameters as Record<string, unknown> } : {}),
        ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
      },
    };
  });
  if (JSON.stringify(tools).length > MAX_TOOLS_CHARS) throw new GatewayError(413, "too_large", `tools exceed ${MAX_TOOLS_CHARS} characters.`);
  return tools.length ? tools : undefined;
}

function validateToolChoice(raw: unknown, tools?: ToolDefinition[]): ToolChoice | undefined {
  if (raw == null) return undefined;
  if (!tools) throw new GatewayError(400, "invalid_request", "tool_choice requires tools.");
  if (raw === "auto" || raw === "none" || raw === "required") return raw;
  const name = (raw as { type?: unknown; function?: { name?: unknown } })?.function?.name;
  if ((raw as { type?: unknown })?.type === "function" && typeof name === "string") {
    if (!tools.some((t) => t.function.name === name)) throw new GatewayError(400, "invalid_request", `tool_choice names unknown tool '${name}'.`);
    return { type: "function", function: { name } };
  }
  throw new GatewayError(400, "invalid_request", "tool_choice must be 'auto', 'none', 'required' or {type:'function',function:{name}}.");
}

function validateResponseFormat(raw: unknown): ResponseFormat | undefined {
  if (raw == null) return undefined;
  const type = (raw as { type?: unknown })?.type;
  if (type === "text" || type === "json_object") return { type };
  if (type === "json_schema") {
    const js = (raw as { json_schema?: { name?: unknown; schema?: unknown; strict?: unknown; description?: unknown } }).json_schema;
    if (!js || typeof js.name !== "string") throw new GatewayError(400, "invalid_request", "response_format.json_schema needs a name.");
    if (js.schema != null && (typeof js.schema !== "object" || Array.isArray(js.schema))) throw new GatewayError(400, "invalid_request", "response_format.json_schema.schema must be an object.");
    if (JSON.stringify(js).length > MAX_TOOLS_CHARS) throw new GatewayError(413, "too_large", "response_format schema too large.");
    return { type, json_schema: { name: js.name, ...(js.schema ? { schema: js.schema as Record<string, unknown> } : {}), ...(typeof js.strict === "boolean" ? { strict: js.strict } : {}), ...(typeof js.description === "string" ? { description: js.description } : {}) } };
  }
  throw new GatewayError(400, "invalid_request", "response_format.type must be text, json_object or json_schema.");
}

function validateStop(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  const arr = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(arr) || arr.length > 4 || !arr.every((s) => typeof s === "string" && s.length > 0 && s.length <= 64)) throw new GatewayError(400, "invalid_request", "stop must be a string or up to 4 strings of 1–64 characters.");
  return arr as string[];
}

export function validateChat(body: unknown): ChatRequest {
  if (!body || typeof body !== "object") throw new GatewayError(400, "invalid_request", "Body must be a JSON object.");
  const b = body as Record<string, unknown>;
  const model = typeof b.model === "string" ? b.model : "brain/auto";
  if (!MODEL_IDS.has(model)) throw new GatewayError(404, "model_not_found", `Unknown model '${model}'.`);
  if (!Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > MAX_MESSAGES) {
    throw new GatewayError(400, "invalid_request", `messages must be an array of 1–${MAX_MESSAGES} items.`);
  }
  const messages: ChatMessage[] = b.messages.map((raw) => {
    const m = raw as Partial<ChatMessage> & { content?: unknown };
    const role = m?.role as string;
    if (!ROLES.has(role)) throw new GatewayError(400, "invalid_request", "Each message needs a role of system, user, assistant or tool.");
    const content = textContent(m.content);
    if (content === undefined) throw new GatewayError(400, "invalid_request", "Message content must be a string or an array of text parts.");
    const out: ChatMessage = { role: role as ChatMessage["role"], content };
    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      out.tool_calls = m.tool_calls.map((t) => {
        if (!t || t.type !== "function" || typeof t.id !== "string" || typeof t.function?.name !== "string") throw new GatewayError(400, "invalid_request", "assistant.tool_calls entries need id, type 'function' and function.name.");
        return { id: t.id, type: "function", function: { name: t.function.name, arguments: typeof t.function.arguments === "string" ? t.function.arguments : JSON.stringify(t.function.arguments ?? {}) } };
      });
    }
    if (role === "tool") {
      if (typeof m.tool_call_id !== "string") throw new GatewayError(400, "invalid_request", "tool messages need tool_call_id.");
      out.tool_call_id = m.tool_call_id;
      if (content == null) out.content = "";
    }
    if (content == null && !(role === "assistant" && out.tool_calls?.length)) throw new GatewayError(400, "invalid_request", "Only an assistant message with tool_calls may have null content.");
    if (typeof m.name === "string") out.name = m.name.slice(0, 64);
    return out;
  });
  const tools = validateTools(b.tools);
  const tool_choice = validateToolChoice(b.tool_choice, tools);
  const response_format = validateResponseFormat(b.response_format);
  const stop = validateStop(b.stop);
  if (chatChars(messages, tools) > MAX_CHARS + MAX_TOOLS_CHARS) throw new GatewayError(413, "too_large", `Total content exceeds ${MAX_CHARS} characters.`);
  if (chatChars(messages) > MAX_CHARS) throw new GatewayError(413, "too_large", `Total content exceeds ${MAX_CHARS} characters.`);
  const max_tokens = Math.min(4096, Math.max(1, Number(b.max_tokens ?? b.max_completion_tokens) || 512));
  const temperature = Math.min(2, Math.max(0, Number(b.temperature ?? 0.4)));
  return { model, messages, max_tokens, temperature, stream: b.stream === true, ...(tools ? { tools } : {}), ...(tool_choice ? { tool_choice } : {}), ...(response_format ? { response_format } : {}), ...(stop ? { stop } : {}) };
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
