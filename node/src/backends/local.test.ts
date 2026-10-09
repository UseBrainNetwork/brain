import { describe, expect, it, vi } from "vitest";
import { matchServedModel } from "../../models";
import type { JobPayload } from "../../protocol";
import { LocalServerBackend } from "./local";

describe("matchServedModel", () => {
  it("maps the names Ollama, llama.cpp and mlx-lm use onto allowlisted ids", () => {
    expect(matchServedModel("qwen2.5:1.5b-instruct")?.id).toBe("qwen/qwen2.5-1.5b-instruct");
    expect(matchServedModel("Qwen2.5-1.5B-Instruct-Q4_K_M.gguf")?.id).toBe("qwen/qwen2.5-1.5b-instruct");
    expect(matchServedModel("mlx-community/Qwen2.5-7B-Instruct-4bit")?.id).toBe("qwen/qwen2.5-7b-instruct");
    expect(matchServedModel("Qwen/Qwen2.5-7B-Instruct-AWQ")?.id).toBe("qwen/qwen2.5-7b-instruct-awq");
    expect(matchServedModel("mistral:7b-instruct-v0.3")?.id).toBe("mistralai/mistral-7b-instruct-v0.3");
    expect(matchServedModel("llama3.1:8b-instruct-q4_K_M")?.id).toBe("meta-llama/llama-3.1-8b-instruct");
  });
  it("maps nothing for models that are not allowlisted", () => {
    expect(matchServedModel("llama3.2:1b")).toBeUndefined();
    expect(matchServedModel("deepseek-r1:7b")).toBeUndefined();
    expect(matchServedModel("brain/mock")).toBeUndefined();
    expect(matchServedModel("")).toBeUndefined();
  });
});

const sse = (events: unknown[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });

function server(models: string[], opts: { usage?: boolean; tags?: string[]; onBody?: (b: unknown) => void } = {}) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }));
    if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: (opts.tags ?? models).map((name) => ({ name })) }));
    if (url.endsWith("/api/pull")) return new Response(JSON.stringify({ status: "success" }));
    if (url.endsWith("/v1/chat/completions")) {
      opts.onBody?.(JSON.parse(String(init?.body)));
      const events: unknown[] = [{ choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] }];
      if (opts.usage !== false) events.push({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } });
      return new Response(sse(events), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const job: JobPayload = { jobId: "j1", model: "qwen/qwen2.5-1.5b-instruct", messages: [{ role: "user", content: "hi" }], maxTokens: 16, temperature: 0, stop: [], deadlineAt: Date.now() + 10_000, flushMs: 50 };

describe("LocalServerBackend", () => {
  it("advertises only allowlisted models the server lists, under the server's own names", async () => {
    const s = server(["qwen2.5:1.5b-instruct", "llama3.2:1b", "mistral:7b-instruct-v0.3"]);
    const b = new LocalServerBackend({ kind: "ollama", baseUrl: "http://127.0.0.1:11434", fetchImpl: s.fetchImpl });
    expect(await b.discover()).toEqual(["qwen/qwen2.5-1.5b-instruct", "mistralai/mistral-7b-instruct-v0.3"]);
    expect(b.kind).toBe("ollama");
  });

  it("honours BRAIN_NODE_MODELS and explicit name pins", async () => {
    const s = server(["my-quant-of-qwen"]);
    const b = new LocalServerBackend({ kind: "llamacpp", baseUrl: "http://127.0.0.1:8080", models: ["qwen/qwen2.5-3b-instruct"], modelMap: { "qwen/qwen2.5-3b-instruct": "my-quant-of-qwen" }, fetchImpl: s.fetchImpl });
    expect(await b.discover()).toEqual(["qwen/qwen2.5-3b-instruct"]);
    expect(await b.ensureLoaded("qwen/qwen2.5-3b-instruct", new AbortController().signal)).toBe(false);
  });

  it("streams a completion under the served name and reports the server's token usage", async () => {
    let sent: { model?: string; stream?: boolean } = {};
    const s = server(["Qwen2.5-1.5B-Instruct-Q4_K_M"], { onBody: (b) => (sent = b as typeof sent) });
    const b = new LocalServerBackend({ kind: "llamacpp", baseUrl: "http://127.0.0.1:8080", fetchImpl: s.fetchImpl });
    await b.discover();
    const deltas: string[] = [];
    const r = await b.generate(job, (d) => deltas.push(d), new AbortController().signal);
    expect(sent.model).toBe("Qwen2.5-1.5B-Instruct-Q4_K_M");
    expect(sent.stream).toBe(true);
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(r).toEqual({ content: "Hello", finishReason: "stop", usage: { prompt: 12, completion: 2 } });
  });

  it("falls back to counted deltas when the server omits usage", async () => {
    const s = server(["qwen2.5:1.5b-instruct"], { usage: false });
    const b = new LocalServerBackend({ kind: "ollama", baseUrl: "http://127.0.0.1:11434", fetchImpl: s.fetchImpl });
    await b.discover();
    const r = await b.generate(job, () => undefined, new AbortController().signal);
    expect(r.usage.completion).toBe(2);
    expect(r.usage.prompt).toBeGreaterThan(0);
  });

  it("pulls a missing tag on Ollama and reports that a load happened", async () => {
    const s = server([], { tags: [] });
    const b = new LocalServerBackend({ kind: "ollama", baseUrl: "http://127.0.0.1:11434", models: ["qwen/qwen2.5-1.5b-instruct"], fetchImpl: s.fetchImpl });
    expect(await b.discover()).toEqual(["qwen/qwen2.5-1.5b-instruct"]);
    expect(await b.ensureLoaded("qwen/qwen2.5-1.5b-instruct", new AbortController().signal)).toBe(true);
    expect(s.calls).toContain("POST /api/pull");
  });

  it("refuses a model the server does not serve rather than guessing a name", async () => {
    const s = server(["qwen2.5:1.5b-instruct"]);
    const b = new LocalServerBackend({ kind: "mlx", baseUrl: "http://127.0.0.1:8080", fetchImpl: s.fetchImpl });
    await b.discover();
    await expect(b.generate({ ...job, model: "qwen/qwen2.5-7b-instruct" }, () => undefined, new AbortController().signal)).rejects.toThrow(/not served/);
  });
});
