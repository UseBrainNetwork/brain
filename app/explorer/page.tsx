import type { Metadata } from "next";
import { ExplorerStats, JobSearch, LiveJobsTable, LiveNodesTable, TopContributorsTable } from "@/components/explorer/Explorer";
import { JobChain } from "@/components/explorer/JobChain";
import { UnfoldSection } from "@/components/layout/UnfoldSection";
import { Container, Dot, Prov, Section } from "@/components/ui";

export const metadata: Metadata = { title: "Explorer" };

export default function ExplorerPage() {
  return (
    <>
      <Section className="pb-16 pt-[120px] md:pt-[150px]">
        <Container>
          <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
            <div>
              <div className="label mb-5 flex items-center gap-2.5 text-fog">
                <Dot color="ok" /> Network explorer
              </div>
              <h1 className="display text-[52px] sm:text-[80px] md:text-[120px]">Every job, in the open.</h1>
            </div>
            <JobSearch />
          </div>

          <div className="mt-12">
            <ExplorerStats />
          </div>
        </Container>
      </Section>

      <UnfoldSection className="py-20">
        <Container>
          <div className="mb-10 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <h2 className="display-md text-[36px] md:text-[60px]">Watch work move.</h2>
            <p className="max-w-[440px] text-[14px] leading-relaxed text-chalk/55">
              Each block is one job. Its cells are the nodes it was split across, lighting up as they execute and turning green only once the server has verified the result.
            </p>
          </div>
          <JobChain />
          <div className="mt-20 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <h2 className="display-md text-[28px] md:text-[40px]">Real nodes on this server</h2>
            <p className="max-w-[440px] text-[14px] leading-relaxed text-chalk/55">
              Browsers that passed a server-timed benchmark and are taking verification jobs right now. Scores and job counts are computed server-side; nothing here is self-reported.
            </p>
          </div>
          <div className="mt-8">
            <LiveNodesTable />
          </div>
        </Container>
      </UnfoldSection>

      <Section className="py-24">
        <Container>
          <div className="flex items-end justify-between">
            <h2 className="display-md text-[28px] md:text-[40px]">Live jobs</h2>
            <span className="flex items-center gap-2 font-mono text-[11px] text-fog">
              simulated stream <Prov p="simulated" /> · real jobs tagged <Prov p="live" />
            </span>
          </div>
          <div className="mt-5">
            <LiveJobsTable />
          </div>

          <div className="mt-24 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div>
              <h2 className="display-md flex items-center gap-3 text-[28px] md:text-[40px]">
                Top contributors <Prov p="simulated" />
              </h2>
              <p className="mt-3 max-w-[520px] text-[14px] leading-relaxed text-ink/60">
                Ranked by verified compute this epoch. Nodes are anonymous 4-hex ids. No wallets, IPs or device names are ever shown.
              </p>
            </div>
          </div>
          <div className="mt-8">
            <TopContributorsTable />
          </div>
        </Container>
      </Section>
    </>
  );
}
