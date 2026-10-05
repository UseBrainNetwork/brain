import type { Metadata } from "next";
import { ContributeFlow } from "@/components/contribute/ContributeFlow";
import { Container, Section } from "@/components/ui";

export const metadata: Metadata = { title: "Contribute GPU" };

export default function ContributePage() {
  return (
    <Section tone="light" className="min-h-dvh pb-24 pt-[104px]">
      <Container>
        <div className="mb-8 flex flex-col justify-between gap-6 md:mb-10 md:flex-row md:items-end">
          <div>
            <div className="label mb-4 text-signal">Contribute GPU</div>
            <h1 className="display text-[48px] md:text-[88px]">Power the brain.</h1>
          </div>
          <p className="max-w-[420px] text-[16px] leading-relaxed text-ink/65">
            Everything below runs in this tab: real WebGPU detection, a real benchmark, real jobs verified by the server. Nothing is installed.
          </p>
        </div>
        <ContributeFlow />
      </Container>
    </Section>
  );
}
