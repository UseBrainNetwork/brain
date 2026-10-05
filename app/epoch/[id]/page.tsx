import type { Metadata } from "next";
import { Hash, Metric, NodeLink, Panel, PageHead, Shell, SourceBadge, sol, when } from "@/components/economy/parts";
import { cx, fmtInt } from "@/lib/format";
import { getEpochV2, verifyEpochHash } from "@/services/epochs";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `Epoch ${id}` };
}

export default async function EpochPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const e = await getEpochV2(decodeURIComponent(id));
  if (!e) {
    return (
      <Shell>
        <div className="font-mono text-[12px] text-chalk/50">Reward epoch</div>
        <h1 className="display mt-3 text-[48px] text-chalk">{id}</h1>
        <p className="mt-6 font-mono text-[13px] text-chalk/60">No finalized epoch with this id exists on this server.</p>
      </Shell>
    );
  }
  const valid = verifyEpochHash(e);
  return (
    <Shell>
      <PageHead
        eyebrow={
          <>
            Reward epoch · finalized <SourceBadge source={e.source} />
            <span className={valid ? "text-ok" : "text-signal"}>{valid ? "HASH VERIFIED" : "HASH MISMATCH"}</span>
          </>
        }
        title={e.epochId}
      >
        {when(e.startsAt)} → {when(e.endsAt)}. Allocations were computed once from server-verified work and are immutable. Recompute the hash from the table below to check nothing changed.
      </PageHead>
      <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-7 md:grid-cols-4">
        <Metric k="Pool" v={sol(e.poolLamports)} big />
        <Metric k="Distributed" v={sol(e.distributedLamports)} big sub={e.poolLamports ? `${((e.distributedLamports / e.poolLamports) * 100).toFixed(1)}% of pool` : undefined} />
        <Metric k="Participants" v={e.participants} />
        <Metric k="Verified compute" v={fmtInt(e.totalVerifiedCompute)} />
      </div>
      <Panel className="mt-10" title="Allocations" right="sorted by node id">
        {e.allocations.length === 0 ? (
          <div className="font-mono text-[12px] text-chalk/45">No node had verified compute in this epoch, so nothing was distributed.</div>
        ) : (
          <div className="grid gap-1 font-mono text-[12px]">
            <div className="grid grid-cols-[80px_1fr_1fr_1fr_1fr_1fr] gap-4 px-3 text-[10px] uppercase tracking-[0.12em] text-chalk/40">
              <span>Node</span>
              <span>Verified compute</span>
              <span>Holding ×</span>
              <span>Quality ×</span>
              <span>Share</span>
              <span>Reward</span>
            </div>
            {e.allocations.map((a) => (
              <div key={a.nodeId} className={cx("grid grid-cols-[80px_1fr_1fr_1fr_1fr_1fr] gap-4 rounded-[6px] px-3 py-2 odd:bg-chalk/[0.03]", a.capped && "text-warn")}>
                <NodeLink id={a.nodeId} />
                <span>{fmtInt(a.verifiedCompute)}</span>
                <span>{a.holdingMultiplier.toFixed(3)}</span>
                <span>{a.qualityMultiplier.toFixed(3)}</span>
                <span>
                  {(a.share * 100).toFixed(2)}%{a.capped && " (capped)"}
                </span>
                <span>{sol(a.lamports)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Panel title="Result hash">
          <Hash value={e.resultHash} />
          <p className="mt-3 text-[12px] text-chalk/50">sha256 over `epochId | pool | nodeId:verifiedCompute:lamports…` in node-id order.</p>
        </Panel>
        <Panel title="Engine configuration">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-[12px]">
            {Object.entries(e.config).map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-chalk/10 py-1">
                <span className="text-chalk/50">{k}</span>
                <span>{v}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-chalk/50">Zero verified compute always yields zero. Holding tokens multiplies verified work by at most {e.config.maxHoldingMultiplier}×; it is never paid on its own.</p>
        </Panel>
      </div>
    </Shell>
  );
}
