import type { Metadata } from "next";
import Link from "next/link";
import { Metric, NO_DATA, Panel, PageHead, Shell, SourceBadge, ms, pct, when } from "@/components/economy/parts";
import { cx, fmtInt } from "@/lib/format";
import { nodeProfile } from "@/services/nodeProfile";
import { publicJob } from "@/services/nodes";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ nodeId: string }> }): Promise<Metadata> {
  const { nodeId } = await params;
  return { title: `Node ${nodeId.toUpperCase()}`, robots: { index: false } };
}

/** Public reputation for one anonymous node. No rarity, no tiers: the numbers are the profile. */
export default async function NodePage({ params }: { params: Promise<{ nodeId: string }> }) {
  const { nodeId } = await params;
  const id = decodeURIComponent(nodeId).toUpperCase();
  const p = await nodeProfile(id);
  if (!p) {
    return (
      <Shell>
        <div className="font-mono text-[12px] text-chalk/50">Node</div>
        <h1 className="display mt-3 text-[48px] text-chalk">{id}</h1>
        <p className="mt-6 font-mono text-[13px] text-chalk/60">No node with this id is known to this server.</p>
      </Shell>
    );
  }
  const jobs = (await getStore().listJobsForNode(id, 25)).map(publicJob);
  return (
    <Shell>
      <PageHead
        eyebrow={
          <>
            Node reputation <SourceBadge source={p.source} />
            <span className={cx("flex items-center gap-1.5", p.online ? "text-ok" : "text-chalk/40")}>
              <span className={cx("inline-block size-[5px]", p.online ? "bg-ok animate-pulse-dot" : "bg-chalk/30")} /> {p.online ? "ONLINE" : "OFFLINE"}
            </span>
          </>
        }
        title={p.nodeId}
      >
        Anonymous persistent identity. Every figure below is measured by the server from issued work; nothing is self-reported. No IP, location or wallet is shown.
      </PageHead>

      <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-7 md:grid-cols-3 lg:grid-cols-5">
        <Metric k="Reputation score" v={p.reputationScore.toFixed(3)} big tone={p.reputationScore >= 0.9 ? "ok" : p.reputationScore >= 0.6 ? undefined : "bad"} sub="EWMA, failures weigh double" />
        <Metric k="Verified compute units" v={fmtInt(p.computeUnits)} big />
        <Metric k="Verification rate" v={pct(p.verificationRate)} sub={`${p.jobsVerified} verified · ${p.jobsFailed} failed`} />
        <Metric k="Uptime" v={pct(p.uptime, 0)} sub="heartbeats observed ÷ expected" />
        <Metric k="Median latency" v={ms(p.medianLatencyMs)} sub="assign → verified, server-timed" />
        <Metric k="Jobs completed" v={p.jobsCompleted} />
        <Metric k="Reassignment rate" v={pct(p.reassignmentRate)} sub="units lost or expired ÷ assigned" />
        <Metric k="Verified score" v={fmtInt(p.computeScore)} sub={p.deviceClass} />
        <Metric k="First seen" v={<span className="text-[14px]">{when(p.firstSeenAt)}</span>} />
        <Metric k="Last seen" v={<span className="text-[14px]">{when(p.lastSeenAt)}</span>} />
      </div>

      <Panel className="mt-10" title="Recent work issued to this node" right={`${jobs.length} records`}>
        {jobs.length === 0 ? (
          <div className="font-mono text-[12px] text-chalk/45">{NO_DATA}</div>
        ) : (
          <div className="grid gap-1 font-mono text-[12px]">
            {jobs.map((j) => (
              <div key={j.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 rounded-[6px] px-3 py-2 odd:bg-chalk/[0.03]">
                <span className="truncate">
                  <Link href={`/explorer/job/${j.id}`} className="text-chalk hover:underline">
                    #{j.id}
                  </Link>{" "}
                  <span className="text-chalk/40">{j.model}</span>
                </span>
                <span className="text-chalk/60">{fmtInt(j.computeUnits)} u</span>
                <span className="text-chalk/60">{j.latencyMs != null ? ms(j.latencyMs) : "—"}</span>
                <span className={j.status === "completed" ? "text-ok" : j.status === "failed" ? "text-signal" : "text-chalk/60"}>{j.status.toUpperCase()}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </Shell>
  );
}
