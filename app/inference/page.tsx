import type { Metadata } from "next";
import { CodeBlock } from "@/components/developers/CodeBlock";
import { Playground } from "@/components/inference/Playground";
import { Switchboard } from "@/components/inference/Switchboard";
import { Button, Container, Dot, Prov, Section } from "@/components/ui";
import { getInferenceModels } from "@/services/data";
import { UnfoldSection } from "@/components/layout/UnfoldSection";
import { cx, fmtInt } from "@/lib/format";

export const metadata: Metadata = { title: "Inference" };

const statusLabel = { routing: "ROUTER", beta: "BETA", planned: "PLANNED" } as const;

export default function InferencePage() {
  const models = getInferenceModels();
  return (
    <>
      <Section className="pb-20 pt-[120px] md:pt-[150px]">
        <Container>
          <div className="grid gap-10 lg:grid-cols-[1fr_440px] lg:items-end">
            <div>
              <div className="label mb-5 flex items-center gap-2.5 text-fog">
                <Dot color="ok" /> OpenAI-compatible API
              </div>
              <h1 className="display text-[56px] sm:text-[96px] md:text-[150px]">Use the crowd.</h1>
            </div>
            <div className="pb-3">
              <p className="text-[17px] leading-relaxed text-ink/70">
                One endpoint. The router places every request on the best target it can find: the browser network when it can serve the model, cloud fallback when it can&apos;t. Your existing OpenAI SDK works unchanged.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Button href="#playground" arrow>
                  Open playground
                </Button>
                <Button href="/developers" variant="secondary">
                  API reference
                </Button>
              </div>
            </div>
          </div>

          <Switchboard className="mt-16" />

          <div className="mt-4 grid gap-px overflow-hidden rounded-[22px] bg-ink/10 sm:grid-cols-2 xl:grid-cols-4">
            {models.map((m) => (
              <div key={m.id} className="flex flex-col bg-paper p-6">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[15px] font-semibold">{m.id}</span>
                  <span className={cx("rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold", m.status === "routing" ? "bg-ink text-chalk" : "bg-warn/25 text-ink")}>{statusLabel[m.status]}</span>
                </div>
                <p className="mt-4 flex-1 text-[14px] leading-relaxed text-ink/65">{m.description}</p>
                <div className="mt-6 space-y-0 font-mono text-[12px]">
                  <Row k="Context" v={`${fmtInt(m.context)} tok`} />
                  <Row k="Network price / 1M" v={m.networkPricePer1M == null ? <span className="text-ink/35">unpriced</span> : `$${m.networkPricePer1M.toFixed(2)}`} />
                  <Row k="Reference / 1M" v={m.referencePricePer1M == null ? <span className="text-ink/35">unpriced</span> : `$${m.referencePricePer1M.toFixed(2)}`} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 flex items-center gap-2 font-mono text-[11px] text-fog">
            <Prov p="estimated" /> Prices are published after cost benchmarks against reference providers. No savings are claimed until they are measured.
          </p>
        </Container>
      </Section>

      <UnfoldSection id="playground" className="py-24">
        <Container>
          <div className="mb-10 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <h2 className="display-md text-[36px] md:text-[60px]">Playground</h2>
            <p className="max-w-[460px] text-[14.5px] leading-relaxed text-chalk/55">
              Requests go through the same server-side gateway as the public API. Provider keys never leave the server. The execution target and latency are real; the shard plan shows how the browser pool partitions the work and is simulated until distributed LLM execution ships.
            </p>
          </div>
          <Playground />
        </Container>
      </UnfoldSection>

      <Section className="py-24">
        <Container>
          <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:items-center">
            <div>
              <h2 className="display-md text-[36px] md:text-[56px]">Drop-in for your OpenAI client.</h2>
              <p className="mt-5 max-w-[460px] text-[15.5px] leading-relaxed text-ink/65">
                Point the base URL at Brain, choose <span className="font-mono text-[14px]">brain/auto</span>, and keep the rest of your code.
              </p>
              <div className="mt-7">
                <Button href="/developers" arrow>
                  Developer docs
                </Button>
              </div>
            </div>
            <CodeBlock
              lang="js"
              code={`import OpenAI from "openai";

const brain = new OpenAI({
  baseURL: "https://YOUR_BRAIN_HOST/v1",
  apiKey: process.env.BRAIN_API_KEY,
});

const res = await brain.chat.completions.create({
  model: "brain/auto",
  messages: [{ role: "user", content: "Audit this contract…" }],
});`}
            />
          </div>
        </Container>
      </Section>
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between border-t border-ink/10 py-2">
      <span className="text-fog">{k}</span>
      <span className="font-semibold">{v}</span>
    </div>
  );
}
