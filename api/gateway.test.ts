import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { chatCompletionStream, validateChat, GatewayError } = await import("./gateway");

const ENV = ["BRAIN_EXTERNAL_BASE_URL", "BRAIN_EXTERNAL_API_KEY", "BRAIN_EXTERNAL_MODEL", "BRAIN_FALLBACK_BASE_URL", "BRAIN_FALLBACK_API_KEY", "BRAIN_FALLBACK_MODEL"];

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
const chat = () => validateChat({ stream: true, messages: [{ role: "user", content: "hi" }] });

describe("streaming gateway", () => {
  beforeEach(() => ENV.forEach((k) => delete process.env[k]));
  afterEach(() => vi.unstubAllGlobals());

  it("accepts stream: true", () => {
    expect(chat().stream).toBe(true);
  });

  it("returns 503 when nothing can stream", async () => {
    await expect(chatCompletionStream(chat())).rejects.toMatchObject({ status: 503 });
  });

  it("re-frames upstream chunks without leaking upstream ids or model names", async () => {
    Object.assign(process.env, { BRAIN_EXTERNAL_BASE_URL: "http://up/v1", BRAIN_EXTERNAL_API_KEY: "k", BRAIN_EXTERNAL_MODEL: "secret-model" });
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(
        sse([
          `data: ${JSON.stringify({ id: "up-1", model: "secret-model", system_fingerprint: "fp_x", choices: [{ index: 0, delta: { content: "Hel" } }] })}`,
          `data: ${JSON.stringify({ id: "up-1", model: "secret-model", choices: [{ index: 0, delta: { content: "lo" } }] })}`,
          "data: [DONE]",
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const text = await read((await chatCompletionStream(chat())).stream);
    expect(text).not.toContain("secret-model");
    expect(text).not.toContain("up-1");
    expect(text).not.toContain("fp_x");
    const chunks = text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
    expect(chunks.map((c) => c.choices[0].delta.content).join("")).toBe("Hello");
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
    expect(chunks[0].id).toMatch(/^chatcmpl-/);
    expect(chunks[0].model).toBe("brain/auto");
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).stream).toBe(true);
  });

  it("falls back to the next target when the first fails before streaming", async () => {
    Object.assign(process.env, {
      BRAIN_FALLBACK_BASE_URL: "http://a/v1",
      BRAIN_FALLBACK_API_KEY: "k",
      BRAIN_FALLBACK_MODEL: "m",
      BRAIN_EXTERNAL_BASE_URL: "http://b/v1",
      BRAIN_EXTERNAL_API_KEY: "k",
      BRAIN_EXTERNAL_MODEL: "m",
    });
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (calls++ === 0 ? new Response("no", { status: 500 }) : new Response(sse(["data: [DONE]"])))));
    expect(await read((await chatCompletionStream(chat())).stream)).toContain("[DONE]");
    expect(calls).toBe(2);
  });

  it("502s when every target fails", async () => {
    Object.assign(process.env, { BRAIN_EXTERNAL_BASE_URL: "http://b/v1", BRAIN_EXTERNAL_API_KEY: "k", BRAIN_EXTERNAL_MODEL: "m" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const err = await chatCompletionStream(chat()).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(502);
  });
});
