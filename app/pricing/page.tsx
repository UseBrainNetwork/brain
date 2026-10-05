import type { Metadata } from "next";
import Link from "next/link";
import { Button, Container, Section } from "@/components/ui";
import { creditUsd, paymentsConnected, visiblePlans } from "@/lib/plans";
import { earn } from "@/lib/site";
import { snapshot } from "@/services/accounting";
import { computeUnitListPriceUsd, tokenListPricePer1MUsd } from "@/lib/pricing";
import { cx } from "@/lib/format";

export const metadata: Metadata = { title: "Pricing", description: "BRAIN plans and credits. Credits are a unit of the real cost on each receipt." };
export const dynamic = "force-dynamic";

const fmtUsd = (n: number) => (n === 0 ? "$0" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

export default async function PricingPage() {
  const ps = visiblePlans();
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

        <div className={cx("mt-10 grid gap-px overflow-hidden rounded-[22px] bg-ink/10", ps.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2")}>
          {ps.map((p) => {
            const live = p.id === "FREE" || payments;
            return (
              <div key={p.id} className={cx("flex flex-col bg-paper p-7", p.id === "PRO" && "md:bg-white")}>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.14em]">{p.name}</span>
                  {live && <span className="rounded-full bg-ok/20 px-2 py-0.5 font-mono text-[10px] font-semibold text-ink">LIVE</span>}
                </div>
                <div className="mt-6 flex items-baseline gap-2">
                  <span className="num text-[52px] leading-none">{p.priceUsd == null ? "—" : fmtUsd(p.priceUsd)}</span>
                  <span className="font-mono text-[12px] text-fog">/ month</span>
                </div>
                <p className="mt-4 min-h-[48px] text-[14.5px] leading-relaxed text-ink/65">{p.blurb}</p>
                <div className="mt-6 space-y-0 font-mono text-[12px]">
                  <Row k="Credits / month" v={p.includedCredits.toLocaleString("en-US")} />
                  <Row k="What that buys" v={perMonth(p.includedCredits)} />
                  <Row k="Routing modes" v={p.modes.filter((m) => m !== "BROWSER_ONLY").join(" · ")} />
                  <Row k="Private routing" v={p.privateRouting ? "Yes" : "No"} />
                  <Row k="Rate limit" v={`${p.rateLimit} / min`} />
                  <Row k="Receipts" v="Every answer" />
                </div>
                <div className="mt-7">
                  {p.id === "FREE" ? (
                    <Button href="/chat" arrow className="w-full">
                      Use BRAIN free
                    </Button>
                  ) : (
                    <Button disabled className="w-full" variant="secondary">
                      {payments ? `Choose ${p.name}` : "Payments not connected"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          {!payments && (
            <div className="flex flex-col justify-between bg-ink p-7 text-chalk">
              <div>
                <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.14em] text-chalk/70">Paid plans</span>
                <h3 className="display-md mt-6 text-[30px] leading-[1.05] md:text-[36px]">More credits, every routing mode, private routing.</h3>
                <p className="mt-4 text-[14.5px] leading-relaxed text-chalk/60">
                  Paid plans open when billing does. Until then the Free plan is the whole product, and your own machines can pay for it: verified compute earns credits now, and USDC or SOL when payouts open.
                </p>
              </div>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button href="/earn" tone="dark" variant="secondary" arrow>
                  {earn.line}
                </Button>
              </div>
            </div>
          )}
        </div>

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
