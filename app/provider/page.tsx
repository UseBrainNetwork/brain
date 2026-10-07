import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, Shell, SourceBadge } from "@/components/economy/parts";
import { ProviderDashboard } from "@/components/provider/ProviderDashboard";

export const metadata: Metadata = { title: "Provider", description: "Operator dashboard for a Brain Node: status, load, jobs, uptime, reliability and ledger earnings." };
export const dynamic = "force-dynamic";

export default async function ProviderPage({ searchParams }: { searchParams: Promise<{ node?: string }> }) {
  const { node } = await searchParams;
  const initial = typeof node === "string" && /^N-[0-9A-Fa-f]{8}$/.test(node) ? node.toUpperCase() : null;
  return (
    <Shell>
      <PageHead
        eyebrow={
          <>
            Provider <SourceBadge source="REAL" />
          </>
        }
        title="Your Brain Node."
        right={
          <div className="flex gap-4 font-mono text-[11px] uppercase tracking-[0.12em] text-chalk/60">
            <Link href="/network" className="hover:text-chalk">
              Network →
            </Link>
            <Link href="/models" className="hover:text-chalk">
              Models →
            </Link>
          </div>
        }
      >
        What the coordinator knows about a node. Hardware and utilization are marked <span className="font-mono text-chalk/70">reported</span> because the node sends them; jobs, speed, uptime, reliability and earnings are the coordinator&apos;s own records.
      </PageHead>
      <div className="mt-10">
        <ProviderDashboard initialNodeId={initial} />
      </div>
    </Shell>
  );
}
