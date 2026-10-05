import Link from "next/link";
import { EconomicsBrief } from "@/components/home/EconomicsBrief";
import { JobPipeline } from "@/components/home/JobPipeline";
import { CrowdScale } from "@/components/home/CrowdScale";
import { HeroDive } from "@/components/home/HeroDive";
import { NodePlate } from "@/components/home/NodePlate";
import { LiveNetworkPanel } from "@/components/network/LiveNetworkPanel";
import { RealMetricsStrip, ResourceClasses } from "@/components/home/RealMetrics";
import { CodeBlock } from "@/components/developers/CodeBlock";
import { Button, Container, Section } from "@/components/ui";
import { getInferenceModels } from "@/services/data";

const curl = `curl https://brainnetwork.app/v1/chat/completions \\
  -H "Authorization: Bearer $BRAIN_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "brain/auto",
    "messages": [{"role": "user", "content": "Explain this contract"}]
  }'`;

export default function Home() {
  return (
    <>
      <HeroDive />

      <Section tone="dark" className="py-10 md:py-14">
        <Container>
          <RealMetricsStrip tone="dark" />
        </Container>
      </Section>

      <JobPipeline />

      <CrowdScale />

      <Section tone="dark" className="py-20 md:py-28">
        <Container>
          <div className="mb-10 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <h2 className="display-md text-[34px] md:text-[56px]">Live topology</h2>
            <p className="max-w-[440px] text-[14.5px] leading-relaxed text-chalk/55">
              Four classes of supply, each shown in its real state. The graph below is the browser network: requests enter, split across device classes, execute, and merge. Green markers are real browsers connected right now; grey cells are simulated scale.
            </p>
          </div>
          <ResourceClasses className="mb-5" />
          <LiveNetworkPanel />
        </Container>
      </Section>

      {/* THE MOMENT */}
      <Section tone="light" className="py-24 md:py-36">
        <Container className="grid grid-cols-1 items-center gap-16 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <div className="label mb-5 text-signal">Power BRAIN</div>
            <h2 className="display text-[44px] md:text-[80px]">
              Your computer
              <br />
              can power BRAIN.
            </h2>
            <p className="mt-6 max-w-[520px] text-[17px] leading-relaxed text-ink/70">
              No install, no driver, no CLI. Open a tab, let it measure your GPU, and join. The server issues a challenge only a real GPU can answer in time, then starts
              sending verifiable work.
            </p>
            <ol className="mt-10 max-w-[560px] border-t border-ink/15">
              {[
                ["01", "Detect", "Reads exactly what WebGPU exposes. Anything it can’t see is labeled unavailable, never guessed."],
                ["02", "Benchmark", "A WGSL kernel on your GPU. Score comes from the server’s clock, not yours."],
                ["03", "Join", "Your node appears in the topology and starts receiving jobs within seconds."],
              ].map(([n, t, d]) => (
                <li key={n} className="grid grid-cols-[48px_130px_1fr] items-baseline gap-2 border-b border-ink/15 py-4 max-sm:grid-cols-[40px_1fr]">
                  <span className="font-mono text-[12px] text-ink/40">{n}</span>
                  <span className="text-[16px] font-semibold">{t}</span>
                  <span className="text-[14px] leading-snug text-ink/60 max-sm:col-span-2 max-sm:col-start-2">{d}</span>
                </li>
              ))}
            </ol>
            <div className="mt-10 flex flex-wrap gap-3">
              <Button href="/earn" arrow>
                Power BRAIN
              </Button>
              <Button href="/explorer" variant="secondary">
                See live jobs
              </Button>
            </div>
          </div>
          <NodePlate />
        </Container>
      </Section>

      <EconomicsBrief />

      {/* INFERENCE */}
      <Section tone="light" className="py-24 md:py-36">
        <Container className="grid grid-cols-1 gap-14 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <div className="label mb-5 text-signal">Use BRAIN</div>
            <h2 className="display text-[44px] md:text-[80px]">
              One chat.
              <br />
              Every receipt.
            </h2>
            <p className="mt-6 max-w-[480px] text-[17px] leading-relaxed text-ink/70">
              Ask in the app or call the OpenAI-compatible API. BRAIN AUTO estimates every execution target, picks one for your mode and privacy, and tells you exactly where the answer ran and what it cost.
            </p>
            <ul className="mt-10 border-t border-ink/15">
              {getInferenceModels().map((m) => (
                <li key={m.id} className="flex items-baseline justify-between gap-6 border-b border-ink/15 py-4">
                  <span className="font-mono text-[14px] font-medium">{m.id}</span>
                  <span className="text-right text-[13.5px] text-ink/55">{m.description}</span>
                </li>
              ))}
            </ul>
            <div className="mt-10 flex flex-wrap gap-3">
              <Button href="/chat" arrow>
                Open BRAIN chat
              </Button>
              <Button href="/developers" variant="secondary">
                API reference
              </Button>
            </div>
          </div>
          <div className="self-center">
            <CodeBlock code={curl} lang="bash" title="POST /v1/chat/completions" />
            <p className="mt-4 font-mono text-[11px] text-ink/45">
              Drop-in for OpenAI SDKs: set <code>base_url</code> to your BRAIN endpoint. <Link className="underline decoration-ink/30 underline-offset-2" href="/developers">Examples →</Link>
            </p>
          </div>
        </Container>
      </Section>
    </>
  );
}
