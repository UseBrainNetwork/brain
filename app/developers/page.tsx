import Link from "next/link";
import type { Metadata } from "next";
import { Architecture } from "@/components/developers/Architecture";
import { CodeBlock, CodeTabs } from "@/components/developers/CodeBlock";
import { Button, Container, Dot, Section } from "@/components/ui";
import { modeWeights } from "@/engine/router";
import { networkConfig } from "@/lib/config";
import { cx } from "@/lib/format";
import { MODEL_ALLOWLIST } from "@/node/models";
import { DEFAULTS } from "@/node/protocol";

export const metadata: Metadata = { title: "Developers" };
export const dynamic = "force-dynamic";

const PY = `from openai import OpenAI

client = OpenAI(
    base_url="https://YOUR_BRAIN_HOST/v1",
    api_key="YOUR_BRAIN_API_KEY",
)

res = client.chat.completions.create(
    model="brain/auto",
    messages=[{"role": "user", "content": "Summarize this audit report."}],
)

print(res.choices[0].message.content)
print(res.model_extra["brain"]["target"])  # BROWSER_NETWORK | NATIVE_NETWORK | CLOUD_GPU | EXTERNAL_MODEL`;

const JS = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://YOUR_BRAIN_HOST/v1",
  apiKey: process.env.BRAIN_API_KEY,
});

const res = await client.chat.completions.create({
  model: "brain/auto",
  messages: [{ role: "user", content: "Summarize this audit report." }],
});

console.log(res.choices[0].message.content);

// Streaming uses the standard SSE chunk format. After the last token BRAIN sends an
// \`event: brain\` message with the route, model, cost and receipt id.
const stream = await client.chat.completions.create({
  model: "brain/auto",
  stream: true,
  // BRAIN extensions (ignored by other servers): mode and privacy
  // @ts-expect-error extension fields
  mode: "auto", privacy: "standard",
  messages: [{ role: "user", content: "Summarize this audit report." }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");`;

const CURL = `curl https://YOUR_BRAIN_HOST/v1/chat/completions \\
  -H "Authorization: Bearer $BRAIN_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "brain/auto",
    "messages": [{"role": "user", "content": "Summarize this audit report."}]
  }'`;

const RESPONSE = `{
  "id": "chatcmpl-3f9c…",
  "object": "chat.completion",
  "model": "brain/auto",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 412, "completion_tokens": 233, "total_tokens": 645 },
  "brain": {
    "orderId": "o-…", "decisionId": "d-…", "planId": "p-…", "receiptId": "r-c-…",
    "mode": "AUTO", "privacy": "STANDARD",
    "target": "EXTERNAL_MODEL", "provider": "external", "model": "meta-llama/…",
    "nodesUsed": 0, "latencyMs": 1184,
    "cost": { "amount": 0.0000084, "currency": "USD", "basis": "list-price" },
    "verification": "unverified-provider-response", "verified": false
  }
}`;

const TOOLS = `from openai import OpenAI
client = OpenAI(base_url="https://brainnetwork.app/v1", api_key="brain_sk_...")

tools = [{"type": "function", "function": {
    "name": "get_weather",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
}}]

r = client.chat.completions.create(model="brain/auto", tools=tools, tool_choice="auto",
    messages=[{"role": "user", "content": "Weather in Oslo?"}])
call = r.choices[0].message.tool_calls[0]        # finish_reason == "tool_calls"
result = get_weather(**json.loads(call.function.arguments))

r2 = client.chat.completions.create(model="brain/auto", tools=tools, messages=[
    {"role": "user", "content": "Weather in Oslo?"},
    r.choices[0].message,
    {"role": "tool", "tool_call_id": call.id, "content": json.dumps(result)},
])
print(r2.choices[0].message.content)
# Every response still carries r.brain: target, model, latency, cost.`;

const ERRORS = [
  ["400", "invalid_request", "Malformed body, bad roles or empty messages."],
  ["401", "invalid_api_key", "Missing, unknown or revoked API key."],
  ["402", "out_of_credits", "The account behind the key has used its included credits for the month."],
  ["403", "mode_not_in_plan", "The requested mode or PRIVATE routing is not in the account's plan."],
  ["404", "model_not_found", "Model id is not one of the brain/* models."],
  ["413", "too_large", "Prompt exceeds the V1 size limit."],
  ["429", "rate_limited", "Per-IP fixed window exceeded."],
  ["502", "upstream_failed", "Every eligible target failed; the order and decision ids are returned for inspection."],
  ["503", "no_provider_available", "No target met the constraints (capability, privacy, budget); the decision explains why."],
];

const PROTOCOL = [
  ["POST", "/api/benchmark/challenge", "Server issues a seeded WGSL workload. Its clock starts now."],
  ["POST", "/api/nodes/register", "Node returns the result; server spot-checks secret blocks and scores on its own clock."],
  ["POST", "/api/nodes/join", "Standby node goes live and is announced to the network."],
  ["POST", "/api/nodes/heartbeat", `Every ${networkConfig.nodes.heartbeatMs / 1000}s. Silent for ${networkConfig.nodes.offlineAfterMs / 1000}s = offline.`],
  ["POST", "/api/jobs/next", "Pull a job. Inputs are a seed; expected outputs never leave the server."],
  ["POST", "/api/jobs/result", "Submit hashes. Verified, reputation updated, compute credited."],
  ["POST", "/api/nodes/leave", "Revokes the session token."],
  ["GET", "/api/network/stream", "Server-Sent Events: joins, leaves, verified jobs."],
];

const NODE_PROTOCOL = [
  ["POST", "/api/coordinator/register", "Node sends its ed25519 public key, hardware report and model list. Node id = hash of the key; the id is bound to the key on first use."],
  ["POST", "/api/coordinator/heartbeat", `Every ${DEFAULTS.heartbeatMs / 1000}s with telemetry. Silent for ${DEFAULTS.offlineAfterMs / 1000}s = OFFLINE and its jobs are re-queued.`],
  ["POST", "/api/coordinator/work", `Long-poll (≤${DEFAULTS.workPollMs / 1000}s) for an assigned job. Outbound only; nodes open no ports.`],
  ["POST", "/api/coordinator/jobs/:id/started · progress · completed · failed", "Status, streamed deltas with sequence numbers, final content hash. Every call is signed over method, path, timestamp and body."],
  ["GET", "/api/coordinator/nodes · /jobs · /signer", "Public registry (no IPs, no keys), public job history, and the key that signs receipts."],
];

const HEADERS = [
  ["brain-request-id", "Id of this request; also the receipt lookup key."],
  ["brain-node-id", "Which Brain Node generated the answer, when one did."],
  ["brain-region", "The operator label of that node's region."],
  ["brain-latency", "Wall time of the request in ms, measured by the gateway."],
  ["x-brain-receipt", "Receipt id. GET /api/receipts/:id for the signed compute receipt."],
];

const NODE_CURL = `# Same request, pinned to a model served by Brain Nodes.
curl https://brainnetwork.app/v1/chat/completions \
  -H "Authorization: Bearer $BRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen/qwen2.5-7b-instruct", "stream": true,
       "messages": [{"role": "user", "content": "Hello from a Brain Node"}]}'

# → brain-node-id: N-3A4F…   brain-region: eu-north   brain-latency: 1184`;

const VERIFICATION: [string, string, "live" | "interface"][] = [
  ["Server-issued challenges", "Benchmarks and jobs are generated server-side from secret seeds. Clients cannot pick their own work.", "live"],
  ["Server-clock scoring", "Compute score = verified ops ÷ server-measured wall time. The client's timing is recorded but never trusted.", "live"],
  ["Secret spot-checks", `The server recomputes ${networkConfig.jobs.sampledRows} randomly chosen rows / blocks it never reveals. One mismatch fails the job.`, "live"],
  ["Canary jobs", `${Math.round(networkConfig.jobs.canaryRate * 100)}% of jobs are small canaries with a fully known answer.`, "live"],
  ["Plausibility bounds", "Results returned faster than physically possible for the workload are rejected.", "live"],
  ["Reputation", `EWMA over outcomes; failures weigh double. Below ${networkConfig.reputation.banBelow} the node is banned.`, "live"],
  ["Rate limiting", `Per hashed IP, per minute: ${networkConfig.rateLimit.nodeRequests} node calls, ${networkConfig.rateLimit.inferenceRequests * 3} API calls, ${networkConfig.rateLimit.inferenceRequests} playground runs.`, "live"],
  ["Redundant execution", "Same unit to N nodes, majority result wins. Policy + comparison implemented; dispatcher wiring lands with LLM shards.", "interface"],
];

export default function DevelopersPage() {
  const fallback = Boolean(process.env.BRAIN_FALLBACK_BASE_URL && process.env.BRAIN_FALLBACK_API_KEY);
  const external = Boolean(process.env.BRAIN_EXTERNAL_BASE_URL && process.env.BRAIN_EXTERNAL_API_KEY);
  const w = modeWeights.AUTO;
  const criteria = [
    ["Capability", "Hard filter. Can this target run this request at all?", "required"],
    ["Privacy", "Hard filter. STANDARD keeps plaintext off untrusted nodes; PRIVATE allows operator infrastructure only.", "required"],
    ["Budget", "Hard filter. maxCost / maxLatency when supplied.", "required"],
    ["Cost", "Estimated USD for this request from configured prices. UNKNOWN is penalised, never treated as free.", w.costWeight.toFixed(2)],
    ["Latency", "Measured median latency of the target for this request class. UNKNOWN penalised.", w.latencyWeight.toFixed(2)],
    ["Reliability", "Measured success rate of the target.", w.reliabilityWeight.toFixed(2)],
    ["Quality", "Operator-configured quality tier. Dominant in QUALITY mode; UNKNOWN penalised.", w.qualityWeight.toFixed(2)],
  ];

  return (
    <>
      <Section tone="dark" className="pb-24 pt-[120px] md:pt-[150px]">
        <Container>
          <div className="grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-start">
            <div>
              <div className="label mb-5 flex items-center gap-2.5 text-chalk/55">
                <Dot color="ok" /> Developers
              </div>
              <h1 className="display text-[60px] md:text-[120px]">Change one URL.<br />Run AI on Brain.</h1>
              <p className="mt-7 max-w-[480px] text-[17px] leading-relaxed text-chalk/65">
                Brain speaks the OpenAI Chat Completions format. Change the base URL, set <span className="font-mono text-[15px] text-chalk">model: &quot;brain/auto&quot;</span>, and the router does the rest.
              </p>
              <p className="mt-4 max-w-[480px] text-[14.5px] leading-relaxed text-chalk/55">
                Create a key under{" "}
                <Link href="/account" className="text-chalk underline decoration-chalk/25 underline-offset-4">
                  Account → API keys
                </Link>
                . Every request needs one; requests draw from the same credits as chat and return the same receipt.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button href="/chat" tone="dark" arrow>
                  Try BRAIN chat
                </Button>
                <Button href="#protocol" tone="dark" variant="secondary">
                  Node protocol
                </Button>
              </div>
              <div className="mt-12 font-mono text-[13px]">
                <div className="flex items-center gap-3 border-y border-chalk/10 py-3">
                  <span className="rounded bg-signal px-1.5 py-0.5 text-[11px] font-semibold text-white">POST</span>
                  /v1/chat/completions
                </div>
                <div className="flex items-center gap-3 border-b border-chalk/10 py-3">
                  <span className="rounded bg-chalk/15 px-1.5 py-0.5 text-[11px] font-semibold">GET</span>
                  /v1/models
                </div>
              </div>
            </div>
            <CodeTabs
              tabs={[
                { label: "Python", lang: "python", code: PY },
                { label: "JavaScript", lang: "js", code: JS },
                { label: "cURL", lang: "bash", code: CURL },
              ]}
            />
          </div>
        </Container>
      </Section>

      <Section tone="dark" id="architecture" className="border-t border-chalk/[0.06] py-24">
        <Container>
          <div className="mb-10 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <h2 className="display-md text-[36px] md:text-[56px]">Request path</h2>
            <p className="max-w-[460px] text-[14.5px] leading-relaxed text-chalk/55">
              Target status below is read from this server&apos;s configuration at request time. Keys stay in server environment variables and are never sent to the browser.
            </p>
          </div>
          <Architecture fallback={fallback} external={external} />

          <div className="mt-16 grid gap-10 lg:grid-cols-[360px_1fr]">
            <div>
              <h3 className="display-md text-[26px] md:text-[34px]">Routing</h3>
              <p className="mt-4 text-[14.5px] leading-relaxed text-chalk/55">
                Ineligible targets are filtered out, the rest ranked by a weighted score (weights shown for <span className="font-mono text-chalk">mode: auto</span>; CHEAP, FAST and QUALITY re-weight). Every response carries <span className="font-mono text-chalk">brain.decisionId</span>; fetch the full decision from <span className="font-mono text-chalk">/api/orders/:orderId</span> or open the receipt.
              </p>
            </div>
            <div className="font-mono text-[12.5px]">
              {criteria.map(([k, d, v]) => (
                <div key={k} className="grid grid-cols-[150px_1fr_80px] gap-4 border-b border-chalk/10 py-3.5">
                  <span className="font-semibold text-chalk">{k}</span>
                  <span className="font-sans text-[14px] text-chalk/55">{d}</span>
                  <span className={cx("text-right", v === "required" ? "text-signal" : "text-chalk/80")}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        </Container>
      </Section>

      <Section className="py-24">
        <Container>
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <h2 className="display-md text-[32px] md:text-[48px]">Response</h2>
              <p className="mt-4 max-w-[460px] text-[15px] leading-relaxed text-ink/65">
                Standard OpenAI shape, plus a <span className="font-mono text-[14px]">brain</span> extension that tells you where the request ran and why. SDKs ignore unknown fields.
              </p>
              <div className="mt-10 font-mono text-[12.5px]">
                {ERRORS.map(([s, c, d]) => (
                  <div key={c} className="grid grid-cols-[44px_190px_1fr] gap-3 border-b border-ink/10 py-2.5 max-md:grid-cols-[44px_1fr]">
                    <span className="font-semibold">{s}</span>
                    <span className="text-ink/80">{c}</span>
                    <span className="font-sans text-[13.5px] text-ink/55 max-md:col-span-2">{d}</span>
                  </div>
                ))}
              </div>
            </div>
            <CodeBlock lang="json" title="200 · application/json" code={RESPONSE} />
          </div>

          <div id="tools" className="mt-24 grid gap-10 lg:grid-cols-2">
            <div>
              <h2 className="display-md text-[32px] md:text-[48px]">Tools and structured output</h2>
              <p className="mt-4 max-w-[460px] text-[15px] leading-relaxed text-ink/65">
                Agents work unchanged. <span className="font-mono text-[14px]">tools</span>, <span className="font-mono text-[14px]">tool_choice</span>, <span className="font-mono text-[14px]">response_format</span> (<span className="font-mono text-[14px]">json_object</span> or <span className="font-mono text-[14px]">json_schema</span>) and <span className="font-mono text-[14px]">stop</span> are validated and forwarded; <span className="font-mono text-[14px]">tool_calls</span> come back in the message and in stream deltas, with <span className="font-mono text-[14px]">finish_reason: &quot;tool_calls&quot;</span>. Assistant messages with <span className="font-mono text-[14px]">tool_calls</span> and <span className="font-mono text-[14px]">tool</span> role messages are accepted for the round trip.
              </p>
              <div className="mt-8 space-y-3 text-[14px] leading-relaxed text-ink/65">
                <p>
                  <span className="font-semibold text-ink">Routing.</span> A request that needs tools is classified with the <span className="font-mono text-[13px]">tools</span> capability and only targets that support it are eligible. Browser nodes never are; if no capable target is configured you get <span className="font-mono text-[13px]">503 no_provider_available</span>, not a text answer pretending to be a tool call.
                </p>
                <p>
                  <span className="font-semibold text-ink">Honesty note.</span> How well a schema is followed depends on the model that ran, which the receipt names. Set <span className="font-mono text-[13px]">strict: true</span> and validate the JSON on your side; BRAIN does not repair model output.
                </p>
                <p>
                  <span className="font-semibold text-ink">Limits.</span> Up to 64 tools and 64k characters of schema per request; text content parts are accepted, image parts are rejected rather than dropped.
                </p>
              </div>
            </div>
            <CodeBlock lang="python" title="tool round trip · openai sdk" code={TOOLS} />
          </div>
        </Container>
      </Section>

      <Section tone="dark" id="nodes" className="py-24">
        <Container>
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <h2 className="display-md text-[32px] md:text-[48px]">Brain Nodes</h2>
              <p className="mt-4 max-w-[460px] text-[14.5px] leading-relaxed text-chalk/55">
                Machines running the Brain Node agent serve open-weight models through vLLM. Ask for one of these model ids and the router picks a node by capability, availability, measured speed, reliability and ask price; there is no silent substitution. If no node can serve it you get <span className="font-mono text-chalk">503</span> with the reason. Which nodes are online right now is on{" "}
                <Link href="/models" className="text-chalk underline decoration-chalk/25 underline-offset-4">
                  /models
                </Link>
                .
              </p>
              <div className="mt-8 font-mono text-[12.5px]">
                {MODEL_ALLOWLIST.filter((m) => !m.mock).map((m) => (
                  <div key={m.id} className="grid grid-cols-[1fr_90px_90px] gap-3 border-b border-chalk/10 py-2.5">
                    <span className="text-chalk">{m.id}</span>
                    <span className="text-chalk/55">{m.params}</span>
                    <span className="text-right text-chalk/55">{Math.round(m.minVramMb / 1024)} GB+</span>
                  </div>
                ))}
              </div>
              <p className="mt-6 max-w-[460px] text-[13.5px] leading-relaxed text-chalk/45">
                Node models run on hardware BRAIN does not operate, so they are <span className="font-mono text-chalk/70">privacy: public</span> by default. Receipts for node work say <span className="font-mono text-chalk/70">node-reported</span>: the coordinator checks the response hash, stream consistency and timing, it does not yet re-execute the model.
              </p>
              <div className="mt-8 font-mono text-[12.5px]">
                {HEADERS.map(([h, d]) => (
                  <div key={h} className="grid grid-cols-[170px_1fr] gap-3 border-b border-chalk/10 py-2.5">
                    <span className="text-chalk">{h}</span>
                    <span className="font-sans text-[13.5px] text-chalk/55">{d}</span>
                  </div>
                ))}
              </div>
            </div>
            <CodeBlock lang="bash" title="node model · response headers" code={NODE_CURL} />
          </div>
          <div className="mt-16 grid gap-10 lg:grid-cols-[360px_1fr]">
            <div>
              <h3 className="display-md text-[26px] md:text-[34px]">Node agent protocol</h3>
              <p className="mt-4 text-[14.5px] leading-relaxed text-chalk/55">
                <span className="font-mono text-chalk">npm run node</span> on a machine with an NVIDIA GPU and Docker; <span className="font-mono text-chalk">BRAIN_NODE_MODE=mock</span> anywhere to exercise the network without a GPU. Mock nodes are labelled and only ever serve <span className="font-mono text-chalk">brain/mock</span>.
              </p>
            </div>
            <div className="font-mono text-[12.5px]">
              {NODE_PROTOCOL.map(([m, p, d]) => (
                <div key={p} className="grid grid-cols-[52px_250px_1fr] items-baseline gap-3 border-b border-chalk/10 py-3 max-lg:grid-cols-[52px_1fr]">
                  <span className={cx("font-semibold", m === "GET" ? "text-chalk/60" : "text-signal")}>{m}</span>
                  <span className="break-words">{p}</span>
                  <span className="font-sans text-[13.5px] text-chalk/55 max-lg:col-span-2">{d}</span>
                </div>
              ))}
            </div>
          </div>
        </Container>
      </Section>

      <Section tone="dark" id="protocol" className="border-t border-chalk/[0.06] py-24">
        <Container>
          <div className="grid gap-10 lg:grid-cols-[360px_1fr]">
            <div>
              <h2 className="display-md text-[32px] md:text-[48px]">Browser node protocol</h2>
              <p className="mt-4 text-[14.5px] leading-relaxed text-chalk/55">
                What a contributing browser does. Session tokens are random, stored only as hashes, and bound to one node.
              </p>
            </div>
            <div className="font-mono text-[12.5px]">
              {PROTOCOL.map(([m, p, d]) => (
                <div key={p} className="grid grid-cols-[52px_250px_1fr] items-baseline gap-3 border-b border-chalk/10 py-3 max-lg:grid-cols-[52px_1fr]">
                  <span className={cx("font-semibold", m === "GET" ? "text-chalk/60" : "text-signal")}>{m}</span>
                  <span>{p}</span>
                  <span className="font-sans text-[13.5px] text-chalk/55 max-lg:col-span-2">{d}</span>
                </div>
              ))}
            </div>
          </div>
        </Container>
      </Section>

      <Section tone="dark" id="verification" className="border-t border-chalk/[0.06] py-24">
        <Container>
          <div className="mb-10 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <h2 className="display-md text-[32px] md:text-[48px]">Contributors are adversarial.</h2>
            <p className="max-w-[460px] text-[14.5px] leading-relaxed text-chalk/55">
              The server never trusts a client&apos;s claimed GPU, score, uptime or results. Rewards follow verified work only.
            </p>
          </div>
          <div className="grid gap-px overflow-hidden rounded-[20px] bg-chalk/10 md:grid-cols-2">
            {VERIFICATION.map(([t, d, s]) => (
              <div key={t} className="bg-ink-2 p-6">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[16px] font-semibold">{t}</span>
                  <span className={cx("font-mono text-[10.5px] font-semibold", s === "live" ? "text-ok" : "text-warn")}>{s === "live" ? "ENFORCED" : "INTERFACE"}</span>
                </div>
                <p className="mt-2.5 text-[14px] leading-relaxed text-chalk/55">{d}</p>
              </div>
            ))}
          </div>
        </Container>
      </Section>
    </>
  );
}
