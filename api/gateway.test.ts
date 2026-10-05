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
    expect(c.max_tokens).toBe(2048);
  });
  it("rejects unknown models and bad messages", () => {
    expect(() => validateChat({ model: "gpt-9", messages: [{ role: "user", content: "hi" }] })).toThrow(GatewayError);
    expect(() => validateChat({ messages: [] })).toThrow(/messages/);
    expect(() => validateChat({ messages: [{ role: "robot", content: "x" }] })).toThrow(/role/);
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

describe("validateChat · tools and structured output", () => {
  const weather = { type: "function", function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } } };

  it("accepts tools, tool_choice, response_format and stop, and forwards them", () => {
    const r = validateChat({
      messages: [{ role: "user", content: "Weather in Oslo?" }],
      tools: [weather],
      tool_choice: "auto",
      response_format: { type: "json_object" },
      stop: ["END"],
    });
    expect(r.tools?.[0].function.name).toBe("get_weather");
    expect(r.tool_choice).toBe("auto");
    expect(r.response_format).toEqual({ type: "json_object" });
    expect(r.stop).toEqual(["END"]);
  });

  it("accepts a full tool round-trip: assistant tool_calls with null content, then a tool message", () => {
    const r = validateChat({
      messages: [
        { role: "user", content: "Weather in Oslo?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: '{"temp_c":4}' },
      ],
      tools: [weather],
    });
    expect(r.messages[1].content).toBeNull();
    expect(r.messages[1].tool_calls?.[0].function.arguments).toBe('{"city":"Oslo"}');
    expect(r.messages[2].tool_call_id).toBe("call_1");
  });

  it("joins text content parts", () => {
    const r = validateChat({ messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] });
    expect(r.messages[0].content).toBe("a\nb");
  });

  it("rejects null content without tool_calls, bad tool shapes, unknown tool_choice targets and bad formats", () => {
    expect(() => validateChat({ messages: [{ role: "assistant", content: null }] })).toThrow(GatewayError);
    expect(() => validateChat({ messages: [{ role: "tool", content: "x" }] })).toThrow(/tool_call_id/);
    expect(() => validateChat({ messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "bad name!" } }] })).toThrow(GatewayError);
    expect(() => validateChat({ messages: [{ role: "user", content: "x" }], tools: [weather], tool_choice: { type: "function", function: { name: "nope" } } })).toThrow(/unknown tool/);
    expect(() => validateChat({ messages: [{ role: "user", content: "x" }], tool_choice: "auto" })).toThrow(/requires tools/);
    expect(() => validateChat({ messages: [{ role: "user", content: "x" }], response_format: { type: "xml" } })).toThrow(GatewayError);
    expect(() => validateChat({ messages: [{ role: "user", content: "x" }], response_format: { type: "json_schema", json_schema: {} } })).toThrow(/name/);
  });

  it("rejects image parts (text only) rather than silently dropping them", () => {
    expect(() => validateChat({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] })).toThrow(GatewayError);
  });
});
