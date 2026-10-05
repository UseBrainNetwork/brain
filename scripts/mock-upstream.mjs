// Dev fixture: a minimal OpenAI-compatible upstream for testing the gateway's success path.
//   node scripts/mock-upstream.mjs [port]
// Then run the app with BRAIN_EXTERNAL_BASE_URL=http://localhost:<port>/v1 BRAIN_EXTERNAL_API_KEY=test BRAIN_EXTERNAL_MODEL=mock
import http from "node:http";

const port = Number(process.argv[2] ?? 3999);
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url !== "/v1/chat/completions" || req.headers.authorization !== "Bearer test") {
        res.writeHead(req.url === "/v1/chat/completions" ? 401 : 404).end();
        return;
      }
      const { messages = [], stream } = JSON.parse(body || "{}");
      const prompt = messages.at(-1)?.content ?? "";
      const content = `[mock upstream] Received ${prompt.length} characters. This response comes from scripts/mock-upstream.mjs, not a model.`;
      if (stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const words = content.split(" ");
        let i = 0;
        const t = setInterval(() => {
          if (i < words.length) {
            res.write(`data: ${JSON.stringify({ id: "upstream-secret-id", model: "mock-upstream-model", choices: [{ index: 0, delta: { content: (i ? " " : "") + words[i] } }] })}\n\n`);
            i++;
          } else {
            clearInterval(t);
            res.end("data: [DONE]\n\n");
          }
        }, 30);
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "mock", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 24, total_tokens: 124 } }));
      }, 250);
    });
  })
  .listen(port, () => console.log(`mock upstream on :${port}`));
