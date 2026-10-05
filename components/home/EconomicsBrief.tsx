import { EarningsCalculator } from "@/components/economics/EarningsCalculator";
import { UnfoldSection } from "@/components/layout/UnfoldSection";
import { Button, Container } from "@/components/ui";

export function EconomicsBrief() {
  return (
    <UnfoldSection className="py-24 md:py-32">
      <Container>
        <div className="label mb-5 text-signal">Rewards</div>
        <h2 className="display text-[clamp(44px,8vw,112px)]">
          What your
          <br />
          GPU earns.
        </h2>
        <div className="mt-8 flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <p className="max-w-[520px] text-[16.5px] leading-relaxed text-chalk/65">
            Rewards are paid for verified compute, from creator fees and inference sales. Holding tokens raises your multiplier, up to a cap. Holding alone earns nothing.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button href="/earn" tone="dark" arrow>
              Measure your GPU
            </Button>
            <Button href="/rewards#formula" tone="dark" variant="secondary">
              How rewards work
            </Button>
          </div>
        </div>
        <div className="mt-14">
          <EarningsCalculator compact />
        </div>
      </Container>
    </UnfoldSection>
  );
}
