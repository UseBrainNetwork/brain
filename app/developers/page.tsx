import type { Metadata } from "next";
import { Architecture } from "@/components/developers/Architecture";
import { CodeBlock, CodeTabs } from "@/components/developers/CodeBlock";
import { Button, Container, Dot, Section } from "@/components/ui";
import { defaultRoutingWeights } from "@/providers/router";
import { networkConfig } from "@/lib/config";
import { cx } from "@/lib/format";

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
print(res.model_extra["brain"]["target"])  # BROWSER_NETWORK | CLOUD_FALLBACK | EXTERNAL_MODEL_PROVIDER`;

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

// Streaming uses the standard SSE chunk format. The target is in the x-brain-target header.
const stream = await client.chat.completions.create({
  model: "brain/auto",
  stream: true,
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
    "target": "CLOUD_FALLBACK",
    "provider": "cloud-fallback",
    "latencyMs": 1184,
    "routing": { "ranked": [ … ], "selected": { … } },
    "attempts": [{ "providerId": "cloud-fallback", "ok": true }],
    "plan": { "provenance": "simulated", "shards": [ … ] }
  }
}`;

const ERRORS = [
  ["400", "invalid_request", "Malformed body, bad roles or empty messages."],
  ["401", "invalid_api_key", "Missing or unknown API key (when BRAIN_API_KEYS is set)."],
  ["404", "model_not_found", "Model id is not one of the brain/* models."],
  ["413", "too_large", "Prompt exceeds the V1 size limit."],
  ["429", "rate_limited", "Per-IP fixed window exceeded."],
  ["502", "upstream_failed", "Every eligible target failed; attempts are listed."],
  ["503", "no_provider_available", "No target can serve the model; routing trace included."],
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
  const w = defaultRoutingWeights;
  const criteria = [
    ["Compatibility", "Hard filter. Can this target run this model at all?", "required"],
    ["Capacity", "Free capacity on the target right now.", w.capacity.toFixed(2)],
    ["Latency", "Estimated time to first full response.", w.latency.toFixed(2)],
    ["Cost", "USD per 1M tokens. Unknown cost is scored neutral, not free.", w.cost.toFixed(2)],
    ["Reliability", "Rolling success rate of the target.", w.reliability.toFixed(2)],
    ["Network preference", "Bias toward the browser pool when it is eligible.", `+${w.browserPreference.toFixed(2)}`],
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
              <h1 className="display text-[60px] md:text-[120px]">Build on the crowd.</h1>
              <p className="mt-7 max-w-[480px] text-[17px] leading-relaxed text-chalk/65">
                Brain speaks the OpenAI Chat Completions format. Change the base URL, set <span className="font-mono text-[15px] text-chalk">model: &quot;brain/auto&quot;</span>, and the router does the rest.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button href="/inference#playground" tone="dark" arrow>
                  Try the playground
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
                Ineligible targets are filtered out, the rest ranked by a weighted score. Weights are configurable per request class. Every response carries the full decision in <span className="font-mono text-chalk">brain.routing</span>.
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
        </Container>
      </Section>

      <Section tone="dark" id="protocol" className="py-24">
        <Container>
          <div className="grid gap-10 lg:grid-cols-[360px_1fr]">
            <div>
              <h2 className="display-md text-[32px] md:text-[48px]">Node protocol</h2>
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
