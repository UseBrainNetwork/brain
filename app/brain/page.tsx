import type { Metadata } from "next";
import { BrainLive, BrainStats, JobWaterfall, ModelPools } from "@/components/network/BrainView";
import { Button, Container, Dot, Section } from "@/components/ui";

export const metadata: Metadata = { title: "The Brain" };

export default function BrainPage() {
  return (
    <Section tone="dark" className="min-h-dvh pb-28 pt-[104px]">
      <Container>
        <div className="flex flex-col justify-between gap-8 pb-10 md:flex-row md:items-end">
          <div>
            <div className="label mb-5 flex items-center gap-2.5 text-chalk/60">
              <Dot color="ok" /> Status <span className="font-semibold text-ok">ONLINE</span>
            </div>
            <h1 className="display text-[64px] md:text-[150px]">The Brain</h1>
          </div>
          <p className="max-w-[400px] pb-3 text-[16px] leading-relaxed text-chalk/60">
            Every contributing browser, seen as one computer. Clusters are device classes; orange is work in flight. Green markers are real nodes connected to this server.
          </p>
        </div>

        <BrainStats />

        <div className="mt-10">
          <BrainLive />
        </div>

        <div className="mt-24 flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <h2 className="display-md text-[34px] md:text-[52px]">Model pools</h2>
          <p className="max-w-[420px] text-[14.5px] leading-relaxed text-chalk/55">
            Nodes are grouped into pools by the models their verified memory and score can serve. Pool sizes shift as devices come and go.
          </p>
        </div>
        <div className="mt-8">
          <ModelPools />
        </div>

        <div className="mt-24 grid gap-10 lg:grid-cols-[360px_1fr]">
          <div>
            <h2 className="display-md text-[34px] md:text-[52px]">Jobs in flight</h2>
            <p className="mt-4 text-[14.5px] leading-relaxed text-chalk/55">
              Each row is one job&apos;s lifecycle on a moving six-second window: split, assigned, executing on nodes, verified, merged. Click any job to open it in the explorer.
            </p>
            <div className="mt-8 flex gap-3">
              <Button href="/explorer" tone="dark" arrow>
                Open explorer
              </Button>
              <Button href="/earn" tone="dark" variant="secondary">
                Add your GPU
              </Button>
            </div>
          </div>
          <div className="rounded-[20px] bg-ink-2 p-5 ring-1 ring-chalk/[0.06] md:p-6">
            <JobWaterfall rows={16} />
          </div>
        </div>
      </Container>
    </Section>
  );
}
