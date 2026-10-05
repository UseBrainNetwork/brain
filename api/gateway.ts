import "server-only";
import { randomBytes } from "node:crypto";
import { inferenceModels } from "@/services/mock/mockData";
import { providers } from "@/providers/registry";
import { route, type RoutingDecision } from "@/providers/router";
import type { ChatMessage, ChatRequest } from "@/providers/types";
import { mulberry32 } from "@/network/workloads";

/**
 * Brain Gateway: validation → routing → execution with fallback → OpenAI-shaped response.
 * Shared by the public /v1 API and the in-site playground.
 */

export class GatewayError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public routing?: RoutingDecision,
    public plan?: ReturnType<typeof shardPlan>,
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
 * How the browser network WOULD shard this request — rendered by the playground and
 * labeled simulated. Deterministic per request id so the visualization is stable.
 */
export function shardPlan(requestId: string, promptChars: number) {
  const rnd = mulberry32(parseInt(requestId.slice(-8), 16) || 1);
  const shards = Math.min(8, Math.max(3, Math.round(promptChars / 160) + 3));
  return {
    provenance: "simulated" as const,
    shards: Array.from({ length: shards }, (_, i) => ({
      nodeId: (rnd() & 0xffff).toString(16).toUpperCase().padStart(4, "0"),
      layers: `${i * 8}–${i * 8 + 7}`,
      units: 4 + (rnd() % 14),
    })),
  };
}

export async function chatCompletion(req: ChatRequest) {
  const id = `chatcmpl-${randomBytes(10).toString("hex")}`;
  const t0 = Date.now();
  const ps = providers();
  const decision = await route(req.model, ps);
  const promptChars = req.messages.reduce((s, m) => s + m.content.length, 0);
  const plan = shardPlan(id, promptChars);
  const eligible = decision.ranked.filter((c) => c.eligible);
  if (eligible.length === 0) {
    throw new GatewayError(
      503,
      "no_provider_available",
      "No execution target can serve this model right now. Configure BRAIN_EXTERNAL_* or BRAIN_FALLBACK_* on the server.",
      decision,
      plan,
    );
  }

  const attempts: { providerId: string; ok: boolean; error?: string }[] = [];
  for (const cand of eligible) {
    const provider = ps.find((p) => p.id === cand.providerId)!;
    try {
      const out = await provider.complete(req);
      attempts.push({ providerId: cand.providerId, ok: true });
      return {
        id,
        object: "chat.completion",
        created: Math.floor(t0 / 1000),
        model: req.model,
        choices: [{ index: 0, message: { role: "assistant", content: out.content }, finish_reason: out.finishReason }],
        usage: out.usage,
        brain: {
          target: cand.target,
          provider: cand.providerId,
          latencyMs: Date.now() - t0,
          routing: decision,
          attempts,
          plan,
        },
      };
    } catch (e) {
      // Only fixed strings go to clients; raw errors could carry upstream URLs.
      const msg = e instanceof Error ? e.message : "";
      attempts.push({ providerId: cand.providerId, ok: false, error: /^upstream \d{3}$/.test(msg) ? msg : e instanceof Error && e.name === "AbortError" ? "timeout" : "unreachable" });
    }
  }
  throw new GatewayError(502, "upstream_failed", "All eligible execution targets failed.", decision, plan);
}

/**
 * Re-frames an upstream OpenAI SSE stream as ours: every chunk gets our id and model name, so
 * upstream identifiers never reach the client. Non-JSON lines pass through untouched.
 */
function reframe(upstream: ReadableStream<Uint8Array>, id: string, model: string, created: number): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  const line = (l: string) => {
    if (!l.startsWith("data:")) return l;
    const payload = l.slice(5).trim();
    if (payload === "[DONE]") return "data: [DONE]";
    try {
      const j = JSON.parse(payload);
      return `data: ${JSON.stringify({ ...j, id, model, created, object: "chat.completion.chunk", system_fingerprint: undefined })}`;
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
        ctl.enqueue(enc.encode(lines.map(line).join("\n") + "\n"));
      },
      flush(ctl) {
        if (buf) ctl.enqueue(enc.encode(line(buf)));
      },
    }),
  );
}

/** Streaming variant: fallback between providers applies until the first provider answers. */
export async function chatCompletionStream(req: ChatRequest): Promise<{ stream: ReadableStream<Uint8Array>; target: string; provider: string }> {
  const id = `chatcmpl-${randomBytes(10).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  const ps = providers();
  const decision = await route(req.model, ps);
  const eligible = decision.ranked.filter((c) => c.eligible && ps.find((p) => p.id === c.providerId)?.stream);
  if (eligible.length === 0) {
    throw new GatewayError(503, "no_provider_available", "No execution target can stream this model right now. Configure BRAIN_EXTERNAL_* or BRAIN_FALLBACK_* on the server.", decision);
  }
  for (const cand of eligible) {
    try {
      const upstream = await ps.find((p) => p.id === cand.providerId)!.stream!(req);
      return { stream: reframe(upstream, id, req.model, created), target: cand.target, provider: cand.providerId };
    } catch {
      // try the next target
    }
  }
  throw new GatewayError(502, "upstream_failed", "All eligible execution targets failed.", decision);
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
