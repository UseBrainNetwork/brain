import type { Metadata } from "next";
import { EarningsCalculator } from "@/components/economics/EarningsCalculator";
import { FlowChain } from "@/components/economics/FlowChain";
import { ProtocolWalletCard, TokenCard } from "@/components/economics/ProtocolWallet";
import { Flywheel } from "@/components/economics/Flywheel";
import { HolderAccess } from "@/components/economics/HolderAccess";
import { MoneyFlow } from "@/components/economics/MoneyFlow";
import { UnfoldSection } from "@/components/layout/UnfoldSection";
import { RewardsDashboard } from "@/components/rewards/RewardsDashboard";
import { Button, Container, Section } from "@/components/ui";
import { fmtPct } from "@/lib/format";
import { defaultRewardConfig } from "@/rewards/config";

export const metadata: Metadata = { title: "Rewards" };

const cfg = defaultRewardConfig;
const PRINCIPLES = [
  ["01", "Compute earns", "Rewards are credited only for work that passes server-side verification. A node with no verified compute receives nothing, regardless of holdings."],
  ["02", "Tokens amplify", `Holdings raise your multiplier on verified compute, up to ${cfg.maxMultiplier}×. Non-holders still earn the full base rate.`],
  ["03", "Bounded by design", `Holdings above ${fmtPct(cfg.tokenShareCap, 0)} of supply count no further, and no node may take more than ${fmtPct(cfg.maxNodeShareOfPool, 0)} of an epoch pool. Splitting wallets gains nothing.`],
  ["04", "Quality matters", `Reliability, completion and uptime scale your share. Below a ${fmtPct(cfg.minVerificationPassRate, 0)} verification pass rate, the epoch is forfeited.`],
];

export default function RewardsPage() {
  return (
    <>
      <Section tone="dark" id="claim" className="pb-24 pt-[120px] md:pt-[150px]">
        <Container>
          <div className="mb-12 flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <div>
              <div className="label mb-5 text-signal">Rewards</div>
              <h1 className="display text-[clamp(48px,9.5vw,136px)]">
                What your
                <br />
                GPU earns.
              </h1>
            </div>
            <p className="max-w-[400px] text-[15.5px] leading-relaxed text-chalk/60">
              Verified compute earns a share of creator fees and inference revenue every epoch. Claim any time once payouts are open; SOL is sent straight to your wallet.
            </p>
          </div>
          <RewardsDashboard />
        </Container>
      </Section>

      <Section tone="dark" id="formula" className="border-t border-chalk/[0.06] py-24">
        <Container>
          <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <div>
              <h2 className="display-md text-[36px] md:text-[56px]">Estimate your earnings</h2>
              <p className="mt-5 max-w-[520px] text-[15.5px] leading-relaxed text-chalk/60">
                Pick your hardware, how long it stays online and what you hold. The estimate runs the production reward formula; it needs a funded pool to mean anything.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button href="/earn" tone="dark" arrow>
                Contribute GPU
              </Button>
              <Button href="/developers#verification" tone="dark" variant="secondary">
                How compute is verified
              </Button>
            </div>
          </div>
          <div className="mt-14">
            <EarningsCalculator />
          </div>
        </Container>
      </Section>

      <Section className="py-24">
        <Container>
          <h2 className="display-md mb-12 text-[36px] md:text-[56px]">How rewards are determined</h2>
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-[20px] bg-ink/10 sm:grid-cols-2 xl:grid-cols-4">
            {PRINCIPLES.map(([n, t, d]) => (
              <div key={t} className="bg-paper p-6 md:p-7">
                <div className="font-mono text-[11px] text-signal">{n}</div>
                <div className="mt-4 text-[18px] font-semibold tracking-tight">{t}</div>
                <p className="mt-2.5 text-[14px] leading-relaxed text-ink/60">{d}</p>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      <UnfoldSection className="py-24">
        <Container>
          <div className="mb-14 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <h2 className="display-md text-[36px] md:text-[56px]">Where rewards come from</h2>
            <p className="max-w-[440px] text-[14.5px] leading-relaxed text-chalk/55">
              The contributor pool is funded by creator fees and inference sales, split by published percentages each epoch. The protocol wallet is published below and read from chain; API billing is not connected yet. Modelled values are available under “Show simulated data” in the footer, labelled SIM.
            </p>
          </div>
          <div className="mb-10 grid gap-5 lg:grid-cols-2">
            <TokenCard />
            <ProtocolWalletCard />
          </div>
          <MoneyFlow className="mb-20 hidden md:block" />
          <FlowChain />
        </Container>
      </UnfoldSection>

      <Section tone="dark" className="border-t border-chalk/[0.06] py-24">
        <Container>
          <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.1fr]">
            <div>
              <h2 className="display-md text-[36px] md:text-[56px]">The flywheel</h2>
              <p className="mt-5 max-w-[460px] text-[15.5px] leading-relaxed text-chalk/60">
                Trading fees fund compute. Verified compute becomes capacity, capacity is sold as inference, and inference revenue pays contributors and buys back the token. Buybacks are trades, so they generate creator fees of their own. Select a stage for detail.
              </p>
              <p className="mt-5 max-w-[460px] text-[13px] leading-relaxed text-chalk/40">Illustrates how revenue is routed. It is not a forecast of reward levels or token price.</p>
            </div>
            <Flywheel className="text-chalk" />
          </div>
        </Container>
      </Section>

      <HolderAccess />
    </>
  );
}
