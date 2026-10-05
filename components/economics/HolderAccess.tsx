import { Container, Dot, KV, Section } from "@/components/ui";
import { fmtPct } from "@/lib/format";
import { defaultRevenueSplit, holderAccessPlan as plan } from "@/rewards/config";

const budgetOfRevenue = defaultRevenueSplit.inferenceRevenue.buyback * plan.budgetShareOfBuyback;

const STEPS = [
  ["01", "Hold", `Link your wallet. Your balance is averaged over ${plan.averagingDays} days, so tokens borrowed for a day don't qualify.`],
  ["02", "Receive an allowance", "Each epoch, a fixed compute budget is divided across holders by their share of averaged holdings."],
  ["03", "Spend it on inference", "Calls to the API draw from your allowance first, then bill at standard rates. Unused allowance expires at the end of the epoch."],
];

const PARAMS: [string, string][] = [
  ["Budget per epoch", `${fmtPct(budgetOfRevenue, 0)} of inference revenue`],
  ["Funded from", `${fmtPct(plan.budgetShareOfBuyback, 0)} of the buyback share`],
  ["Allocation", "Pro rata, time-weighted holdings"],
  ["Averaging window", `${plan.averagingDays} days`],
  ["Holdings counted up to", `${fmtPct(plan.holdingCap, 0)} of supply`],
  ["Resets", "Every epoch"],
  ["Transferable / cashable", "No"],
];

/** Planned holder utility. Copy and parameters only; nothing here is wired to the backend. */
export function HolderAccess() {
  return (
    <Section className="py-24">
      <Container>
        <div className="grid gap-14 lg:grid-cols-[1.15fr_1fr]">
          <div>
            <div className="label mb-5 flex items-center gap-2 text-ink/55">
              <Dot color="warn" /> Planned · not live
            </div>
            <h2 className="display-md text-[36px] md:text-[56px]">
              Hold the token.
              <br />
              <span className="text-ink/40">Use the network.</span>
            </h2>
            <p className="mt-5 max-w-[500px] text-[15.5px] leading-relaxed text-ink/60">
              Holders will receive a free inference allowance on the Brain API. Contributors are still paid in full for serving it: the budget comes out of the share of inference revenue
              that would otherwise go to buybacks. Holders get value either way, as buybacks or as compute they can use.
            </p>
            <div className="mt-10 grid gap-px overflow-hidden rounded-[20px] bg-ink/10 sm:grid-cols-3">
              {STEPS.map(([n, t, d]) => (
                <div key={n} className="bg-paper p-6">
                  <div className="font-mono text-[11px] text-signal">{n}</div>
                  <div className="mt-4 text-[17px] font-semibold tracking-tight">{t}</div>
                  <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink/60">{d}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="self-end rounded-[20px] bg-paper p-6 md:p-8">
            <div className="label mb-4 text-ink/55">Proposed parameters</div>
            {PARAMS.map(([k, v]) => (
              <KV key={k} k={k} v={v} className="py-3" />
            ))}
            <p className="mt-6 text-[12.5px] leading-relaxed text-ink/50">
              This is an access right, not a return. The allowance has no cash value, can&apos;t be sold or withdrawn, and doesn&apos;t depend on the token price. Parameters are
              proposals and may change before launch.
            </p>
          </div>
        </div>
      </Container>
    </Section>
  );
}
