import type { Metadata } from "next";
import Link from "next/link";
import { Button, Container, Section } from "@/components/ui";
import { comingSoon, creditUsd, paymentsConnected, plans } from "@/lib/plans";
import { NotifyButton } from "@/components/pricing/NotifyButton";
import { earn } from "@/lib/site";
import { snapshot } from "@/services/accounting";
import { computeUnitListPriceUsd, tokenListPricePer1MUsd } from "@/lib/pricing";
import { cx } from "@/lib/format";

export const metadata: Metadata = { title: "Pricing", description: "BRAIN plans and credits. Credits are a unit of the real cost on each receipt." };
export const dynamic = "force-dynamic";

const fmtUsd = (n: number) => (n === 0 ? "$0" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

export default async function PricingPage() {
  const ps = plans();
  const cu = creditUsd();
  const snap = await snapshot("REAL");
  const avgReq = snap.avgCostPerJob;
  const perMonth = (credits: number) =>
    avgReq && avgReq > 0 ? `≈ ${Math.floor((credits * cu) / avgReq).toLocaleString("en-US")} requests at the measured average (${snap.pricedReceipts} priced receipts)` : `≈ $${(credits * cu).toFixed(2)} of routed requests at list price`;
  const token = tokenListPricePer1MUsd();
  const compute = computeUnitListPriceUsd();
  const payments = paymentsConnected();
  return (
    <Section tone="light" className="min-h-dvh pb-24 pt-[120px] md:pt-[150px]">
      <Container>
        <div className="grid gap-10 lg:grid-cols-[1fr_420px] lg:items-end">
          <div>
            <div className="label mb-5 text-signal">Pricing</div>
            <h1 className="display text-[52px] md:text-[96px]">Pay for intelligence, not for a model.</h1>
          </div>
          <p className="pb-2 text-[17px] leading-relaxed text-ink/70">
            BRAIN AUTO routes every request to the cheapest path that meets it, and the cost of each answer is on its receipt. Credits are a unit of that real cost: 1 credit = {`$${cu}`}. Compute you contribute offsets what you use.
          </p>
        </div>

        <div className="mt-10 grid gap-px overflow-hidden rounded-[22px] bg-ink/10 md:grid-cols-2 xl:grid-cols-4">
          {ps.map((p) => {
            const soon = comingSoon(p);
            const dark = p.id === "MAX";
            return (
              <div key={p.id} className={cx("flex flex-col p-7", dark ? "bg-ink text-chalk" : p.id === "CODE" ? "bg-white" : "bg-paper")}>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.14em]">{p.name}</span>
                  {soon ? (
                    <span className={cx("rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold", dark ? "bg-chalk/15 text-chalk" : "bg-ink/10 text-ink")}>COMING SOON</span>
                  ) : (
                    <span className="rounded-full bg-ok/20 px-2 py-0.5 font-mono text-[10px] font-semibold text-ink">LIVE</span>
                  )}
                </div>
                <div className="mt-6 flex items-baseline gap-2">
                  <span className="num text-[52px] leading-none">{p.priceUsd == null ? "—" : fmtUsd(p.priceUsd)}</span>
                  <span className={cx("font-mono text-[12px]", dark ? "text-chalk/50" : "text-fog")}>/ month</span>
                </div>
                <div className="mt-3 text-[17px] font-semibold leading-snug">{p.tagline}</div>
                <p className={cx("mt-2 min-h-[66px] text-[14px] leading-relaxed", dark ? "text-chalk/60" : "text-ink/60")}>{p.blurb}</p>
                <ul className={cx("mt-5 space-y-2 border-t pt-5 text-[13.5px] leading-snug", dark ? "border-chalk/15" : "border-ink/10")}>
                  {p.highlights.map((h) => (
                    <li key={h} className="flex gap-2.5">
                      <span className={cx("mt-[7px] size-[6px] shrink-0 rounded-full", dark ? "bg-chalk/70" : soon ? "bg-ink/50" : "bg-ok")} />
                      <span className={dark ? "text-chalk/85" : "text-ink/80"}>{h}</span>
                    </li>
                  ))}
                </ul>
                <div className={cx("mt-5 font-mono text-[11px]", dark ? "text-chalk/45" : "text-fog")}>
                  {perMonth(p.includedCredits)}
                  <br />
                  {p.rateLimit} requests / min · private routing {p.privateRouting ? "yes" : "no"}
                </div>
                <div className="mt-auto pt-7">
                  {!soon ? (
                    <Button href="/chat" arrow className="w-full">
                      Use BRAIN free
                    </Button>
                  ) : payments ? (
                    <Button disabled className="w-full" variant="secondary">
                      Choose {p.name}
                    </Button>
                  ) : (
                    <NotifyButton plan={p.id} planName={p.name} dark={dark} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {!payments && (
          <p className="mt-4 font-mono text-[11.5px] leading-relaxed text-ink/50">
            Coming-soon plans show their intended price and what they will include. Nothing can be purchased yet and no one is charged. Model names are not listed because BRAIN routes by capability and the set changes; the receipt on every answer names the exact model that ran.
          </p>
        )}

        <div className="mt-16 grid gap-10 lg:grid-cols-2">
          <div>
            <h2 className="display-md text-[32px] md:text-[44px]">What a credit buys.</h2>
            <p className="mt-4 max-w-[520px] text-[15px] leading-relaxed text-ink/65">
              Credits are deducted from the receipt&apos;s customer cost, which is computed from the list prices this server is configured with. If a request has no configured price its cost is UNKNOWN, nothing is deducted, and the receipt says so.
            </p>
            <div className="mt-6 font-mono text-[12.5px]">
              <Row k="Chat tokens, list" v={token == null ? "UNKNOWN (unconfigured)" : `$${token.toFixed(2)} per 1M tokens → ${((token / 1e6 / cu) * 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })} credits per 1k tokens`} />
              <Row k="Verified compute, list" v={compute == null ? "UNKNOWN (unconfigured)" : `$${compute} per 1k units`} />
              <Row k="Unknown cost" v="0 credits, flagged on the receipt" />
            </div>
          </div>
          <div>
            <h2 className="display-md text-[32px] md:text-[44px]">{earn.line}</h2>
            <p className="mt-4 max-w-[520px] text-[15px] leading-relaxed text-ink/65">
              Attach the Solana wallet you contribute with. Every dollar your machines earn (REAL accounting lines, accrued at list price) is mirrored into your credit balance today, and settles to that wallet in USDC or SOL when payouts open. Until then the offset is a ledger entry, not a payout.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button href="/earn" variant="secondary" arrow>
                Power BRAIN
              </Button>
              <Link href="/economics" className="inline-flex h-11 items-center font-mono text-[12.5px] text-ink/60 hover:text-ink">
                How the money moves →
              </Link>
            </div>
          </div>
        </div>
      </Container>
    </Section>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-t border-ink/10 py-2">
      <span className="text-fog">{k}</span>
      <span className="text-right font-semibold">{v}</span>
    </div>
  );
}
