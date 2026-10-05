import type { Metadata } from "next";
import Link from "next/link";
import { Button, Container, Section } from "@/components/ui";
import { creditUsd, paymentsConnected, plans } from "@/lib/plans";
import { computeUnitListPriceUsd, tokenListPricePer1MUsd } from "@/lib/pricing";
import { cx } from "@/lib/format";

export const metadata: Metadata = { title: "Pricing", description: "BRAIN plans and credits. Credits are a unit of real cost; placeholder prices are labeled." };
export const dynamic = "force-dynamic";

const fmtUsd = (n: number) => (n === 0 ? "$0" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

export default function PricingPage() {
  const ps = plans();
  const cu = creditUsd();
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
            One subscription. BRAIN AUTO routes every request to the cheapest path that meets it, and the cost of each answer is on its receipt. Credits are a unit of that real cost: 1 credit = {`$${cu}`}.
          </p>
        </div>

        {!payments && (
          <div className="mt-10 rounded-[12px] border border-warn/40 bg-warn/10 px-5 py-4 text-[14px] leading-relaxed text-ink/80">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">Placeholder prices.</span> Payments are not connected yet, so Pro and Max cannot be purchased and their prices are proposals, not offers. The Free plan is live. Compute you contribute already offsets usage on every plan.
          </div>
        )}

        <div className="mt-10 grid gap-px overflow-hidden rounded-[22px] bg-ink/10 md:grid-cols-3">
          {ps.map((p) => {
            const live = p.id === "FREE" || payments;
            return (
              <div key={p.id} className={cx("flex flex-col bg-paper p-7", p.id === "PRO" && "md:bg-white")}>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.14em]">{p.name}</span>
                  <span className={cx("rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold", live ? "bg-ok/20 text-ink" : "bg-warn/25 text-ink")}>{live ? "LIVE" : "PLACEHOLDER"}</span>
                </div>
                <div className="mt-6 flex items-baseline gap-2">
                  <span className="num text-[52px] leading-none">{p.priceUsd == null ? "—" : fmtUsd(p.priceUsd)}</span>
                  <span className="font-mono text-[12px] text-fog">/ month</span>
                </div>
                <p className="mt-4 min-h-[48px] text-[14.5px] leading-relaxed text-ink/65">{p.blurb}</p>
                <div className="mt-6 space-y-0 font-mono text-[12px]">
                  <Row k="Credits / month" v={p.includedCredits.toLocaleString("en-US")} />
                  <Row k="≈ at list price" v={`$${(p.includedCredits * cu).toFixed(2)} of routed requests`} />
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
        </div>

        <div className="mt-16 grid gap-10 lg:grid-cols-2">
          <div>
            <h2 className="display-md text-[32px] md:text-[44px]">What a credit buys.</h2>
            <p className="mt-4 max-w-[520px] text-[15px] leading-relaxed text-ink/65">
              Credits are deducted from the receipt&apos;s customer cost, which is computed from the list prices this server is configured with. If a request has no configured price its cost is UNKNOWN, nothing is deducted, and the receipt says so.
            </p>
            <div className="mt-6 font-mono text-[12.5px]">
              <Row k="Chat tokens, list" v={token == null ? "UNKNOWN (unconfigured)" : `$${token.toFixed(2)} per 1M tokens → ${Math.round((token / 1e6 / cu) * 1000).toLocaleString("en-US")} credits per 1k tokens`} />
              <Row k="Verified compute, list" v={compute == null ? "UNKNOWN (unconfigured)" : `$${compute} per 1k units`} />
              <Row k="Unknown cost" v="0 credits, flagged on the receipt" />
            </div>
          </div>
          <div>
            <h2 className="display-md text-[32px] md:text-[44px]">Pay with compute.</h2>
            <p className="mt-4 max-w-[520px] text-[15px] leading-relaxed text-ink/65">
              Attach the wallet you contribute with and every dollar your machines earn (REAL accounting lines, accrued at list price) is mirrored into your credit balance. That offset is a ledger entry, not a payout: no money moves until payouts are live.
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
