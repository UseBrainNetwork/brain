import type { Metadata } from "next";
import Link from "next/link";
import { NetworkOps } from "@/components/economy/NetworkOps";
import { NativeFleet } from "@/components/network/NativeFleet";
import { PageHead, Shell, SourceBadge } from "@/components/economy/parts";

export const metadata: Metadata = { title: "Network operations", description: "Is this real? Is compute happening? Is someone paying? Who is doing the work? Where is the money going?" };

export default function NetworkPage() {
  return (
    <Shell>
      <PageHead
        eyebrow={
          <>
            Operations <SourceBadge source="REAL" />
          </>
        }
        title="Network operations."
        right={
          <div className="flex gap-4 font-mono text-[11px] uppercase tracking-[0.12em] text-chalk/60">
            <Link href="/demo" className="hover:text-chalk">
              Live view →
            </Link>
            <Link href="/capacity" className="hover:text-chalk">
              Capacity →
            </Link>
          </div>
        }
      >
        Brain Nodes, the jobs flowing through them, and five questions about the browser network, all answered only from this server&apos;s real records. Hardware figures are what nodes reported; everything else the coordinator measured.
      </PageHead>
      <div className="mt-10">
        <NativeFleet />
      </div>
      <div className="mt-10">
        <NetworkOps />
      </div>
    </Shell>
  );
}
