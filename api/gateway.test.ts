import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { reframeStream, validateChat, GatewayError } = await import("./gateway");

function sse(lines: string[]) {
  const enc = new TextEncoder();
  // Split mid-line to exercise buffering across chunks.
  const text = lines.map((l) => `${l}\n\n`).join("");
  const parts = [text.slice(0, 17), text.slice(17, 60), text.slice(60)];
  return new ReadableStream<Uint8Array>({
    start(c) {
      parts.forEach((p) => c.enqueue(enc.encode(p)));
      c.close();
    },
  });
}

const read = (s: ReadableStream<Uint8Array>) => new Response(s).text();

describe("validateChat", () => {
  it("accepts stream: true and defaults", () => {
    const c = validateChat({ stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(c.stream).toBe(true);
    expect(c.model).toBe("brain/auto");
    expect(c.max_tokens).toBe(512);
  });
  it("rejects unknown models and bad messages", () => {
    expect(() => validateChat({ model: "gpt-9", messages: [{ role: "user", content: "hi" }] })).toThrow(GatewayError);
    expect(() => validateChat({ messages: [] })).toThrow(/messages/);
    expect(() => validateChat({ messages: [{ role: "tool", content: "x" }] })).toThrow(/role/);
  });
});

describe("reframeStream", () => {
  it("rewrites ids and model names across chunk boundaries and drops the upstream [DONE]", async () => {
    const upstream = sse([
      'data: {"id":"up-1","model":"meta-llama/llama-3.1-8b-instruct","choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"id":"up-1","model":"meta-llama/llama-3.1-8b-instruct","choices":[{"delta":{"content":"lo"}}]}',
      "data: [DONE]",
    ]);
    const text = await read(reframeStream(upstream, "chatcmpl-x", "brain/auto", 1));
    expect(text).not.toContain("meta-llama");
    expect(text).not.toContain("up-1");
    expect(text).not.toContain("[DONE]");
    expect(text.match(/"id":"chatcmpl-x"/g)?.length).toBe(2);
    expect(text).toContain('"content":"Hel"');
    expect(text).toContain('"content":"lo"');
  });
  it("passes non-JSON lines through", async () => {
    const text = await read(reframeStream(sse([": keepalive"]), "id", "brain/auto", 1));
    expect(text).toContain(": keepalive");
  });
});
