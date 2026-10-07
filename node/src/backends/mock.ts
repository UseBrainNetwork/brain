import type { JobPayload } from "../../protocol";
import type { GenerateResult, InferenceBackend } from "./types";

/**
 * Development backend. Produces deterministic text at a steady rate so the whole pipeline
 * (routing → job → streaming → receipt → accounting) can be exercised on any laptop. It is not a
 * language model and every output says so. It only ever serves the `brain/mock` model id, and the
 * coordinator refuses to list a mock node under any real model.
 */
export class MockBackend implements InferenceBackend {
  readonly kind = "mock" as const;
  private loaded = new Set<string>();
  constructor(private tokensPerSec = 40) {}

  supportedModels() {
    return ["brain/mock"];
  }
  loadedModels() {
    return [...this.loaded];
  }
  async ensureLoaded(model: string) {
    if (this.loaded.has(model)) return false;
    await new Promise((r) => setTimeout(r, 300));
    this.loaded.add(model);
    return true;
  }

  async generate(job: JobPayload, onDelta: (delta: string, tokens: number) => void, signal: AbortSignal): Promise<GenerateResult> {
    const last = [...job.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const promptTokens = Math.ceil(job.messages.reduce((s, m) => s + m.content.length, 0) / 4);
    const words = `[mock] This is a Brain mock node, not a language model. It received ${job.messages.length} message${job.messages.length === 1 ? "" : "s"} (${last.length} characters in the last user turn) for ${job.model} and is streaming this fixed reply at about ${this.tokensPerSec} tokens per second to exercise routing, streaming, receipts and accounting end to end.`.split(" ");
    const limit = Math.max(1, Math.min(job.maxTokens, words.length));
    let content = "";
    let tokens = 0;
    const interval = 1000 / this.tokensPerSec;
    for (let i = 0; i < limit; i++) {
      if (signal.aborted) return { content, finishReason: "cancelled", usage: { prompt: promptTokens, completion: tokens } };
      const piece = (i ? " " : "") + words[i];
      content += piece;
      tokens++;
      onDelta(piece, tokens);
      await new Promise((r) => setTimeout(r, interval));
    }
    return { content, finishReason: limit < words.length ? "length" : "stop", usage: { prompt: promptTokens, completion: tokens } };
  }

  async shutdown() {
    this.loaded.clear();
  }
}
