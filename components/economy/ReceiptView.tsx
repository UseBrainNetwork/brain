import Link from "next/link";
import { receiptStatus, type ComputeReceipt, type RouteDecision } from "@/domain/economy";
import type { DistributedJob } from "@/domain/types";
import { cx, fmtInt } from "@/lib/format";
import { CopyLink } from "./CopyLink";
import { Hash, Metric, NodeLink, Panel, PageHead, Shell, SourceBadge, money, ms, pct, when } from "./parts";

const VERIFICATION_TEXT: Record<ComputeReceipt["verificationMethod"], string> = {
  "spot-check": "The server recomputed secret rows of every work unit and compared row hashes. Confidence is the probability that a node skipping ≥25% of its rows would have been caught.",
  "redundant+spot-check": "Every work unit was computed by two different nodes and their outputs compared, then spot-checked by the server.",
  canary: "The server already knew the full answer and compared it to the node's output.",
  "unverified-provider-response": "An external model provider returned this result. BRAIN did not and could not verify the computation; the hash only fixes the response text.",
  "node-reported": "A native Brain Node produced this result. The coordinator checked that the response hash matches the text, that the final text equals what was streamed, that token counts are plausible and that the claimed duration fits the observed wall time. It did not re-run the model; token counts are the node's claim. The receipt is signed by the coordinator.",
};

export function ReceiptView({ receipt: r, job, decision }: { receipt: ComputeReceipt; job: DistributedJob | null; decision: RouteDecision | null }) {
  const status = receiptStatus(r);
  const statusTone = status === "VERIFIED" ? "text-ok" : status === "PARTIAL" ? "text-warn" : status === "COMPLETED" ? "text-chalk/70" : "text-signal";
  const chat = r.workloadType === "chat";
  return (
    <Shell>
      <PageHead
        eyebrow={
          <>
            Compute receipt <SourceBadge source={r.source} /> <span className={cx("font-semibold", statusTone)}>{status}</span>
          </>
        }
        title={r.receiptId}
        right={<CopyLink />}
      >
        Permanent record of job #{r.jobId}: {r.workloadType === "matmul_u32" ? "parallel integer matrix multiplication executed on real browser GPUs and verified by this server." : "a chat request executed through BRAIN AUTO."}
      </PageHead>

      {r.scheduled && (
        <div className="mt-4 rounded-[10px] border border-chalk/10 bg-chalk/[0.03] px-4 py-3 text-[13px] leading-relaxed text-chalk/70">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-chalk/45">Scheduled work</span>
          <p className="mt-1">
            This workload was scheduled by the operator to keep the network exercised ({r.scheduled.reason}). There is no customer for it and nothing is charged. The nodes below ran and were verified on this server; they are paid for these units from the hourly reward pool like any other verified work.
          </p>
        </div>
      )}
      {r.attachedTo && (
        <div className="mt-6 rounded-[12px] border border-signal/30 bg-signal/[0.06] p-4 text-[12.5px] leading-relaxed text-chalk/75">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-signal">Attached compute</div>
          <p className="mt-1.5">
            This workload was sized by chat request <span className="font-mono text-chalk">{r.attachedTo.orderId}</span> ({r.attachedTo.model}) and dispatched to the browser network after that request completed. The nodes below ran and were verified on this
            matmul; they did <span className="text-chalk">not</span> produce the chat answer, which came from the routed provider. The customer charge lives on the chat receipt; these verified units count toward each node&apos;s hourly reward share.
          </p>
        </div>
      )}

      <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-7 md:grid-cols-4 lg:grid-cols-6">
        <Metric k="Nodes used" v={r.nodesUsed.length} />
        <Metric k="Work units" v={r.workUnits} />
        <Metric k="Verified" v={`${r.verifiedWorkUnits} / ${r.workUnits}`} tone={r.verifiedWorkUnits === r.workUnits ? "ok" : "warn"} />
        <Metric k="Failed · reassigned" v={`${r.failedWorkUnits} · ${r.reassignedWorkUnits}`} />
        <Metric k="Compute units" v={fmtInt(r.totalComputeUnits)} sub={r.verificationMethod === "node-reported" ? "credited for settlement · params × tokens ÷ 2²⁰" : "1 unit ≈ 2²⁰ MACs"} />
        <Metric k="Execution time" v={ms(r.executionTimeMs)} sub={chat ? "request → response" : "request → verified"} />
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
              Integrity digest over the ordered, server-verified outputs. Anyone holding the same outputs can recompute it. It is <span className="text-chalk/80">not</span> a cryptographic proof of execution.
            </p>
          </Panel>
          <Panel title="Attestation" right={r.attestation.kind}>
            {r.attestation.kind === "signature" ? (
              <>
                <div className="font-mono text-[11px] text-chalk/50">signer (ed25519, base64)</div>
                <Hash value={r.attestation.signer} />
                <div className="mt-3 font-mono text-[11px] text-chalk/50">signature</div>
                <Hash value={r.attestation.signature} />
                <p className="mt-3 text-[12px] leading-relaxed text-chalk/50">
                  The coordinator signed the hash of this receipt&apos;s canonical body. Re-check it with nothing but the id at{" "}
                  <a href={`/api/receipts/${encodeURIComponent(r.receiptId)}/verify`} className="font-mono text-chalk/80 underline underline-offset-4">
                    /api/receipts/{r.receiptId}/verify
                  </a>
                  . Not anchored on-chain.
                </p>
              </>
            ) : r.attestation.kind === "anchor" ? (
              <p className="text-[12px] leading-relaxed text-chalk/50">
                Anchored on {r.attestation.chain}, tx <span className="font-mono text-chalk/80">{r.attestation.txId}</span>.
              </p>
            ) : (
              <p className="text-[12px] leading-relaxed text-chalk/50">Unsigned. Browser-pool and upstream-provider receipts carry the integrity digest above and nothing more; only Brain Node receipts are signed by the coordinator.</p>
            )}
          </Panel>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Panel title="Customer cost">
          <div className="font-mono text-[15px] text-chalk">{money(r.customerCost)}</div>
          <p className="mt-2 text-[12px] text-chalk/50">{r.customerCost ? "Accrued at the configured list price. No payment has been collected for this job." : r.attachedTo ? "No separate charge. Paid for by the chat request this compute was attached to." : r.scheduled ? "No customer. Operator-scheduled work is never charged to anyone." : "No list price is configured on this server, so nothing is charged or claimed."}</p>
        </Panel>
        <Panel title="Provider compensation">
          <div className="font-mono text-[15px] text-chalk">{money(r.providerCompensation)}</div>
          <p className="mt-2 text-[12px] text-chalk/50">{r.providerCompensation ? "Split across the nodes above in proportion to verified compute units." : r.workloadType === "chat" ? "Chat ran on an external provider; no browser nodes were compensated." : r.attachedTo || r.scheduled ? "Nodes are paid for these verified units from the hourly reward pool, not from this receipt." : "Nodes were credited compute units; monetary value awaits a price."}</p>
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
        {r.attachedTo && <span>Attached to {r.attachedTo.orderId}</span>}
        {r.scheduled && <span>Scheduled · {r.scheduled.reason}</span>}
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
