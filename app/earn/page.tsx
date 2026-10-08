import type { Metadata } from "next";
import Link from "next/link";
import { earn } from "@/lib/site";
import { ContributeFlow } from "@/components/contribute/ContributeFlow";
import { Container, Section } from "@/components/ui";
import { computeUnitListPriceUsd } from "@/lib/pricing";
import { defaultRevenueSplit } from "@/rewards/config";

export const metadata: Metadata = { title: "Power BRAIN", description: "Your computer can power BRAIN. Real WebGPU detection, a real benchmark, real jobs verified by the server." };
export const dynamic = "force-dynamic";

export default function EarnPage() {
  const unit = computeUnitListPriceUsd();
  const share = Math.round(defaultRevenueSplit.inferenceRevenue.contributors * 100);
  return (
    <Section tone="light" className="min-h-dvh pb-24 pt-[104px]">
      <Container>
        <div className="mb-8 flex flex-col justify-between gap-6 md:mb-10 md:flex-row md:items-end">
          <div>
            <div className="label mb-4 text-signal">Power BRAIN</div>
            <h1 className="display text-[44px] md:text-[88px]">
              Your computer
              <br />
              can power BRAIN.
            </h1>
          </div>
          <div className="max-w-[440px]">
            <p className="text-[16px] leading-relaxed text-ink/65">Everything below runs in this tab: real WebGPU detection, a real benchmark, real jobs verified by the server. Nothing is installed.</p>
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-ink/15 pt-4 font-mono text-[12px]">
              <div>
                <dt className="text-fog">You earn</dt>
                <dd className="mt-0.5 font-semibold">{earn.short}</dd>
              </div>
              <div>
                <dt className="text-fog">Provider share</dt>
                <dd className="mt-0.5 font-semibold">{share}% of list price</dd>
              </div>
              <div>
                <dt className="text-fog">Compute list price</dt>
                <dd className="mt-0.5 font-semibold">{unit == null ? "UNKNOWN" : `$${unit} / 1k units`}</dd>
              </div>
              <div>
                <dt className="text-fog">Pay with compute</dt>
                <dd className="mt-0.5 font-semibold">
                  <Link href="/account" className="underline decoration-ink/30 underline-offset-2">
                    offsets your usage
                  </Link>
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-[11.5px] leading-relaxed text-fog">{earn.how} Earnings accrue at list price as REAL ledger lines; SOL is paid from the epoch pool to wallets that claim it. No return is promised.</p>
          </div>
        </div>
        <ContributeFlow />
      </Container>
    </Section>
  );
}
