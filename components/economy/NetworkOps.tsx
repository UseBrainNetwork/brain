"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ComputeOrder, ComputeReceipt, CustomerRequestRecord, EconomicsSnapshot, NodeReputation } from "@/domain/economy";
import type { ComputeNode, DistributedJob } from "@/domain/types";
import { cx, fmtInt } from "@/lib/format";
import { useReal } from "@/network/realtime/real";
import { Metric, NO_DATA, NodeLink, Panel, SourceBadge, ms, n, pct, usd } from "./parts";

interface Ops {
  backend: "postgres" | "memory";
  nodes: ComputeNode[];
  summary: { realNodes: number; capacityScore: number; verifiedComputeUnits: number; jobsCompleted: number; workUnitsVerified: number; successRate: number | null };
  jobs: DistributedJob[];
  receipts: ComputeReceipt[];
  orders: ComputeOrder[];
  requests: CustomerRequestRecord[];
  profiles: NodeReputation[];
  economics: EconomicsSnapshot;
  recentEvents: { at: number; type: string; detail: string }[];
  observability: { jobLatencyMedianMs: number | null; queueToDistributedMs: number | null; verificationTailMs: number | null; reassignments: number; failedUnits: number; capacityUtilization: number | null };
}

const total = (c: { settled: number | null; accrued: number | null }) => (c.settled == null && c.accrued == null ? null : (c.settled ?? 0) + (c.accrued ?? 0));
const hhmmss = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour12: false });

export function NetworkOps() {
  const [ops, setOps] = useState<Ops | null>(null);
  const feed = useReal((r) => r.feed);
  const connected = useReal((r) => r.connected);
  useEffect(() => {
    let dead = false;
    const load = () =>
      fetch("/api/network/ops")
        .then((r) => r.json())
        .then((j) => !dead && setOps(j))
        .catch(() => {});
    void load();
    const t = setInterval(load, 3000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, []);

  const s = ops?.summary;
  const e = ops?.economics;
  const running = ops?.jobs.find((j) => j.status !== "completed" && j.status !== "failed") ?? null;
  const lastJob = ops?.jobs[0];
  const sinceLast = lastJob ? Date.now() - (lastJob.completedAt ?? lastJob.createdAt) : null;
  const paid = e ? total(e.customersPaid) : null;
  const earned = e ? total(e.providersEarned) : null;
  const top = ops ? (ops.profiles.find((p) => p.online) ?? ops.profiles[0]) : null;

  return (
    <div className="mt-8 space-y-6">
      {/* The five questions */}
      <div className="grid gap-4 md:grid-cols-5">
        <Q q="Is this real?" a={s ? (s.realNodes > 0 ? `${s.realNodes} real ${s.realNodes === 1 ? "node" : "nodes"}` : "0 real nodes") : "…"} tone={s && s.realNodes > 0 ? "ok" : "bad"} sub={connected ? "live event stream connected" : "event stream reconnecting"} />
        <Q q="Is compute happening?" a={running ? `job #${running.id} ${running.status}` : sinceLast == null ? "no jobs yet" : `idle · last job ${ms(sinceLast)} ago`} tone={running ? "ok" : sinceLast != null && sinceLast < 120_000 ? undefined : "muted"} sub={s ? `${fmtInt(s.verifiedComputeUnits)} verified compute units all time` : undefined} />
        <Q q="Is someone paying?" a={paid == null ? "NOT ENOUGH DATA" : `${usd(paid)} ${e!.customersPaid.settled == null ? "accrued" : "settled"}`} tone={paid == null ? "muted" : e!.customersPaid.settled ? "ok" : "warn"} sub={e && e.customersPaid.settled == null && paid != null ? "list-price accruals · no payment collected" : "no customer payments recorded"} />
        <Q q="Who is doing the work?" a={ops ? `${ops.profiles.filter((p) => p.online).length} nodes online · top ${top?.nodeId ?? "—"}` : "…"} sub={top ? `${fmtInt(top.computeUnits)} units · rep ${top.reputationScore.toFixed(2)}${top.online ? "" : " · offline"}` : undefined} />
        <Q q="Where is the money going?" a={earned == null ? "NOT ENOUGH DATA" : `${usd(earned)} to providers`} tone={earned == null ? "muted" : undefined} sub={e ? `${e.events} real accounting events` : undefined} />
      </div>

      {/* Top metrics */}
      <Panel title="Network" right={<SourceBadge source="REAL" />}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-4 lg:grid-cols-8">
          <Metric k="Real nodes" v={s?.realNodes ?? "—"} />
          <Metric k="Capacity" v={s ? fmtInt(s.capacityScore) : "—"} />
          <Metric k="Jobs completed" v={s?.jobsCompleted ?? "—"} />
          <Metric k="Work units verified" v={s?.workUnitsVerified ?? "—"} />
          <Metric k="Success rate" v={pct(s?.successRate)} />
          <Metric k="Median job latency" v={ms(ops?.observability.jobLatencyMedianMs)} />
          <Metric k="Reassignments" v={ops?.observability.reassignments ?? "—"} sub={`${ops?.observability.failedUnits ?? 0} failed units`} />
          <Metric k="Utilization" v={pct(ops?.observability.capacityUtilization, 0)} sub="nodes computing ÷ online" />
        </div>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-[1fr_1fr_380px]">
        <Panel title="Recent receipts" right={<Link href="/economics" className="hover:text-chalk">economics →</Link>}>
          <Rows
            empty="No receipts yet. Run a job from /demo or /auto."
            rows={(ops?.receipts ?? []).slice(0, 8).map((r) => (
              <Link key={r.receiptId} href={`/receipt/${r.receiptId}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-[6px] px-3 py-2 hover:bg-chalk/[0.05]">
                <span className="truncate text-chalk">
                  {r.receiptId} <span className="text-chalk/40">· {r.workloadType}</span>
                </span>
                <span className="text-chalk/60">{r.nodesUsed.length} nodes · {fmtInt(r.totalComputeUnits)} u</span>
                <span className={r.status === "VERIFIED" ? "text-ok" : r.status === "PARTIAL" ? "text-warn" : "text-signal"}>{r.status}</span>
              </Link>
            ))}
          />
        </Panel>
        <Panel title="Nodes" right="by verified compute">
          <Rows
            empty="No nodes have joined this server yet."
            rows={(ops?.profiles ?? []).slice(0, 8).map((p) => (
              <div key={p.nodeId} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 rounded-[6px] px-3 py-2 odd:bg-chalk/[0.03]">
                <span className={cx("inline-block size-[6px]", p.online ? "bg-ok" : "bg-chalk/25")} />
                <NodeLink id={p.nodeId} />
                <span className="text-chalk/60">{fmtInt(p.computeUnits)} u</span>
                <span className="text-chalk/60">rep {p.reputationScore.toFixed(2)}</span>
              </div>
            ))}
          />
        </Panel>
        <Panel title="Live feed" right={<SourceBadge source="REAL" />}>
          <ol className="space-y-[6px] font-mono text-[11px]">
            {feed.slice(0, 14).map((f) => (
              <li key={f.key} className="grid grid-cols-[58px_1fr] gap-2">
                <span className="text-chalk/35">{hhmmss(f.at)}</span>
                <span className="min-w-0">
                  <span className={cx("block truncate", f.tone === "ok" ? "text-ok" : f.tone === "bad" ? "text-signal" : f.tone === "warn" ? "text-warn" : "text-chalk/80")}>{f.title}</span>
                  <span className="block truncate text-chalk/40">{f.detail}</span>
                </span>
              </li>
            ))}
            {feed.length === 0 &&
              (ops?.recentEvents ?? []).slice(0, 14).map((e, i) => (
                <li key={`${e.at}-${i}`} className="grid grid-cols-[58px_1fr] gap-2">
                  <span className="text-chalk/35">{hhmmss(e.at)}</span>
                  <span className="min-w-0">
                    <span className={cx("block truncate", /verified|completed|joined/.test(e.type) ? "text-ok" : /failed|lost|left/.test(e.type) ? "text-signal" : "text-chalk/80")}>{e.type}</span>
                    <span className="block truncate text-chalk/40">{e.detail}</span>
                  </span>
                </li>
              ))}
            {feed.length === 0 && (ops?.recentEvents.length ?? 0) === 0 && <li className="text-chalk/35">No events in the last 15 minutes.</li>}
          </ol>
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Orders" right="compute market">
          <Rows
            empty="No orders yet."
            rows={(ops?.orders ?? []).slice(0, 8).map((o) => (
              <div key={o.orderId} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-[6px] px-3 py-2 odd:bg-chalk/[0.03]">
                <span className="truncate text-chalk">
                  {o.workload} <span className="text-chalk/40">· {o.priority} → {o.mode}</span>
                </span>
                <span className="text-chalk/60">{o.receiptId ? <Link href={`/receipt/${o.receiptId}`} className="hover:text-chalk">{o.receiptId}</Link> : "—"}</span>
                <span className={o.status === "COMPLETED" ? "text-ok" : o.status === "FAILED" || o.status === "REJECTED" ? "text-signal" : "text-warn"}>{o.status}</span>
              </div>
            ))}
          />
        </Panel>
        <Panel title="Customer API requests" right="/v1">
          <Rows
            empty="No API requests recorded."
            rows={(ops?.requests ?? []).slice(0, 8).map((r) => (
              <div key={r.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 rounded-[6px] px-3 py-2 odd:bg-chalk/[0.03]">
                <span className="truncate text-chalk">
                  {r.endpoint} <span className="text-chalk/40">· {r.customerId}</span>
                </span>
                <span className="text-chalk/60">{r.route?.target ?? "—"}</span>
                <span className="text-chalk/60">{ms(r.latencyMs)}</span>
                <span className={r.ok ? "text-ok" : "text-signal"}>{r.ok ? "OK" : "FAIL"}</span>
              </div>
            ))}
          />
        </Panel>
      </div>

      <div className="font-mono text-[11px] text-chalk/40">
        Observability: queue→distributed {ms(ops?.observability.queueToDistributedMs)} · verification tail {ms(ops?.observability.verificationTailMs)} · {n(ops?.jobs.length, " recent jobs")} · store {ops?.backend ?? "…"}{ops?.backend === "memory" ? " (records do not survive a restart)" : ""}. Nothing on this page is simulated.
      </div>
    </div>
  );
}

function Q({ q, a, sub, tone }: { q: string; a: string; sub?: string; tone?: "ok" | "warn" | "bad" | "muted" }) {
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-signal" : tone === "muted" ? "text-chalk/45" : "text-chalk";
  return (
    <div className="rounded-[12px] border border-chalk/10 p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-chalk/45">{q}</div>
      <div className={cx("mt-2 font-mono text-[15px] leading-snug", color)}>{a}</div>
      {sub && <div className="mt-1.5 font-mono text-[10.5px] text-chalk/40">{sub}</div>}
    </div>
  );
}

function Rows({ rows, empty }: { rows: React.ReactNode[]; empty: string }) {
  if (!rows.length) return <div className="font-mono text-[12px] text-chalk/40">{empty === "" ? NO_DATA : empty}</div>;
  return <div className="grid gap-1 font-mono text-[12px]">{rows}</div>;
}
