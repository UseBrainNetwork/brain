import Link from "next/link";
import type { ComputeReceipt, RouteDecision } from "@/domain/economy";
import type { DistributedJob } from "@/domain/types";
import { cx, fmtInt } from "@/lib/format";
import { CopyLink } from "./CopyLink";
import { Hash, Metric, NodeLink, Panel, PageHead, Shell, SourceBadge, money, ms, pct, when } from "./parts";

const VERIFICATION_TEXT: Record<ComputeReceipt["verificationMethod"], string> = {
  "spot-check": "The server recomputed secret rows of every work unit and compared row hashes. Confidence is the probability that a node skipping ≥25% of its rows would have been caught.",
  "redundant+spot-check": "Every work unit was computed by two different nodes and their outputs compared, then spot-checked by the server.",
  canary: "The server already knew the full answer and compared it to the node's output.",
  "unverified-provider-response": "An external model provider returned this result. BRAIN did not and could not verify the computation; the hash only fixes the response text.",
};

export function ReceiptView({ receipt: r, job, decision }: { receipt: ComputeReceipt; job: DistributedJob | null; decision: RouteDecision | null }) {
  const statusTone = r.status === "VERIFIED" ? "text-ok" : r.status === "PARTIAL" ? "text-warn" : "text-signal";
  return (
    <Shell>
      <PageHead
        eyebrow={
          <>
            Compute receipt <SourceBadge source={r.source} /> <span className={cx("font-semibold", statusTone)}>{r.status}</span>
          </>
        }
        title={r.receiptId}
        right={<CopyLink />}
      >
        Permanent record of job #{r.jobId}: {r.workloadType === "matmul_u32" ? "parallel integer matrix multiplication executed on real browser GPUs and verified by this server." : "a chat request executed through BRAIN AUTO."}
      </PageHead>

      <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-7 md:grid-cols-4 lg:grid-cols-6">
        <Metric k="Nodes used" v={r.nodesUsed.length} />
        <Metric k="Work units" v={r.workUnits} />
        <Metric k="Verified" v={`${r.verifiedWorkUnits} / ${r.workUnits}`} tone={r.verifiedWorkUnits === r.workUnits ? "ok" : "warn"} />
        <Metric k="Failed · reassigned" v={`${r.failedWorkUnits} · ${r.reassignedWorkUnits}`} />
        <Metric k="Compute units" v={fmtInt(r.totalComputeUnits)} sub="1 unit ≈ 2²⁰ MACs" />
        <Metric k="Execution time" v={ms(r.executionTimeMs)} sub="request → verified" />
      </div>

      <div className="mt-10 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="Execution" right={job ? `${job.workload.unitDims.m}×${job.workload.unitDims.n}×${job.workload.unitDims.k} u32 · ${job.size}` : r.model}>
          {job ? <Timeline job={job} /> : <div className="font-mono text-[12px] text-chalk/50">No per-unit execution record for this workload type.</div>}
          {r.nodesUsed.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 font-mono text-[12px]">
              <span className="text-chalk/45">Nodes</span>
              {r.nodesUsed.map((id) => (
                <NodeLink key={id} id={id} />
              ))}
            </div>
          )}
        </Panel>

        <div className="space-y-5">
          <Panel title="Verification" right={pct(r.verificationConfidence, 1)}>
            <div className="font-mono text-[13px] text-chalk">{r.verificationMethod}</div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-chalk/55">{VERIFICATION_TEXT[r.verificationMethod]}</p>
          </Panel>
          <Panel title="Result hash" right={r.resultHashLabel}>
            <Hash value={r.resultHash} />
            <p className="mt-3 text-[12px] leading-relaxed text-chalk/50">
              Integrity digest over the ordered, server-verified outputs. Anyone holding the same outputs can recompute it. It is <span className="text-chalk/80">not</span> a cryptographic proof of execution and is not signed or anchored on-chain
              {r.attestation.kind === "none" ? " (attestation: none)." : "."}
            </p>
          </Panel>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Panel title="Customer cost">
          <div className="font-mono text-[15px] text-chalk">{money(r.customerCost)}</div>
          <p className="mt-2 text-[12px] text-chalk/50">{r.customerCost ? "Accrued at the configured list price. No payment has been collected for this job." : "No list price is configured on this server, so nothing is charged or claimed."}</p>
        </Panel>
        <Panel title="Provider compensation">
          <div className="font-mono text-[15px] text-chalk">{money(r.providerCompensation)}</div>
          <p className="mt-2 text-[12px] text-chalk/50">{r.providerCompensation ? "Split across the nodes above in proportion to verified compute units." : r.workloadType === "chat" ? "Chat ran on an external provider; no browser nodes were compensated." : "Nodes were credited compute units; monetary value awaits a price."}</p>
        </Panel>
        <Panel title="Protocol revenue">
          <div className="font-mono text-[15px] text-chalk">{money(r.protocolRevenue)}</div>
          <p className="mt-2 text-[12px] text-chalk/50">Buyback + treasury share of the list price.</p>
        </Panel>
      </div>

      <Panel className="mt-5" title="Route" right={r.route ? `${r.route.target} · ${r.route.providerId}` : "—"}>
        {decision ? (
          <div className="font-mono text-[12px]">
            <div className="text-chalk/80">{decision.reason}</div>
            <div className="mt-3 grid gap-1">
              {decision.estimates.map((e) => (
                <div key={e.provider} className={cx("grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-4 rounded-[6px] px-3 py-2", e.provider === decision.selected?.provider ? "bg-ok/10 text-chalk" : e.eligible ? "text-chalk/70" : "text-chalk/35")}>
                  <span>
                    {e.provider} <span className="text-chalk/40">· {e.target}</span>
                  </span>
                  <span>{e.estimatedCost == null ? "cost UNKNOWN" : `$${e.estimatedCost.toFixed(4)}`}</span>
                  <span>{e.estimatedLatency == null ? "latency UNKNOWN" : ms(e.estimatedLatency)}</span>
                  <span>{(e.estimatedReliability * 100).toFixed(0)}% rel.</span>
                  <span>{e.eligible ? `score ${e.score.toFixed(3)}` : e.notes.at(-1)}</span>
                </div>
              ))}
            </div>
            <div className="mt-2 text-chalk/40">
              Mode {decision.mode}{decision.privacy ? ` · privacy ${decision.privacy}` : ""} · weights cost {decision.weights.costWeight} / latency {decision.weights.latencyWeight} / reliability {decision.weights.reliabilityWeight} / quality {decision.weights.qualityWeight ?? 0} · lower score wins
            </div>
          </div>
        ) : (
          <div className="font-mono text-[12px] text-chalk/50">{r.route ? "Executed directly on the browser network from the demo console (no routing decision recorded)." : "No route recorded."}</div>
        )}
      </Panel>

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[11px] text-chalk/45">
        <span>Created {when(r.createdAt)}</span>
        <span>Completed {when(r.completedAt)}</span>
        {r.orderId && <span>Order {r.orderId}</span>}
        <Link href={`/api/receipts/${r.receiptId}`} className="text-chalk/70 hover:text-chalk">
          JSON →
        </Link>
        {r.workloadType === "matmul_u32" && (
          <Link href={`/explorer/job/${r.jobId}`} className="text-chalk/70 hover:text-chalk">
            Explorer →
          </Link>
        )}
      </div>
    </Shell>
  );
}

/** Per-node lanes; each verified attempt is a bar from assignment to verification. */
function Timeline({ job }: { job: DistributedJob }) {
  const t0 = job.createdAt;
  const t1 = job.completedAt ?? Math.max(t0 + 1, ...job.units.map((u) => u.verifiedAt ?? u.returnedAt ?? u.assignedAt));
  const span = Math.max(1, t1 - t0);
  const nodes = [...new Set(job.units.map((u) => u.nodeId))];
  const x = (t: number) => `${Math.min(100, Math.max(0, ((t - t0) / span) * 100))}%`;
  return (
    <div className="space-y-2 font-mono text-[11px]">
      {nodes.map((id) => (
        <div key={id} className="grid grid-cols-[64px_1fr] items-center gap-3">
          <NodeLink id={id} />
          <div className="relative h-6 rounded-[4px] bg-ink-2">
            {job.units
              .filter((u) => u.nodeId === id)
              .map((u) => {
                const end = u.verifiedAt ?? u.returnedAt ?? (u.status === "lost" || u.status === "mismatch" || u.status === "failed" ? u.assignedAt + Math.min(span * 0.08, 400) : t1);
                const good = u.status === "verified";
                return (
                  <div
                    key={u.id}
                    title={`${u.label}${u.replica ? "′" : ""} · ${u.status}${u.attempt > 1 ? ` · attempt ${u.attempt}` : ""}`}
                    className={cx("absolute top-1 h-4 rounded-[3px] px-1 text-[9px] leading-4", good ? "bg-ok/80 text-ink" : "bg-signal/60 text-white")}
                    style={{ left: x(u.assignedAt), width: `max(10px, calc(${x(end)} - ${x(u.assignedAt)}))` }}
                  >
                    {u.label}
                  </div>
                );
              })}
          </div>
        </div>
      ))}
      <div className="grid grid-cols-[64px_1fr] gap-3 text-chalk/35">
        <span />
        <div className="flex justify-between">
          <span>0 ms</span>
          <span>{fmtInt(span)} ms</span>
        </div>
      </div>
    </div>
  );
}
