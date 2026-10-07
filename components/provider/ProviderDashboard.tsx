"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { PublicInferenceJob } from "@/services/coordinator/jobs";
import type { PublicNativeNode, TelemetrySample } from "@/services/coordinator/registry";
import { cx, fmtInt } from "@/lib/format";
import { Metric, NO_DATA, Panel, UNKNOWN } from "@/components/economy/parts";
import { JobPipeline, NodeDetail, Tag, VerificationTag, gb, kindTag, stateTone, useFleet } from "@/components/network/NativeFleet";

interface View {
  node: PublicNativeNode;
  jobs: PublicInferenceJob[];
  earnings: { accruedUsd: number; settledUsd: number; events: number; basis: string };
  asOf: number;
}

/**
 * Operator view of one Brain Node. Reads /api/coordinator/nodes/<id>. Hardware and utilization
 * are what the node reported (labelled); jobs, speed, uptime, reliability and earnings are what
 * the coordinator recorded. Earnings are the ledger's accrued amounts at list price; nothing has
 * been paid out, and the page says so rather than projecting.
 */
export function ProviderDashboard({ initialNodeId }: { initialNodeId: string | null }) {
  const { nodes } = useFleet(10_000);
  const [nodeId, setNodeId] = useState<string | null>(initialNodeId);
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!nodeId && nodes?.length) setNodeId(nodes[0].nodeId);
  }, [nodes, nodeId]);

  useEffect(() => {
    if (!nodeId) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/coordinator/nodes/${nodeId}`);
        if (!r.ok) throw new Error(r.status === 404 ? "No node with that id has registered." : `HTTP ${r.status}`);
        const v = (await r.json()) as View;
        if (alive) {
          setView(v);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "failed");
      }
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [nodeId]);

  const today = useMemo(() => {
    if (!view) return null;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const js = view.jobs.filter((j) => j.createdAt >= start.getTime() && j.kind === "inference");
    return { jobs: js.filter((j) => j.state === "COMPLETED").length, computeMs: js.reduce((s, j) => s + (j.computeDurationMs ?? 0), 0), tokens: js.reduce((s, j) => s + (j.tokenUsage?.completion ?? 0), 0) };
  }, [view]);

  if (!nodes) return <Panel>{NO_DATA}</Panel>;
  if (!nodes.length && !view) {
    return (
      <Panel title="No Brain Nodes registered">
        <div className="font-mono text-[12.5px] leading-relaxed text-chalk/60">
          Start one and this page fills in from the coordinator&apos;s records.
          <pre className="mt-4 rounded-[10px] border border-chalk/10 bg-ink/40 p-4 text-chalk/80">{`# any machine, exercises the whole network with a labelled mock node
BRAIN_NODE_MODE=mock npm run node

# NVIDIA GPU + Docker: serves allowlisted open-weight models via vLLM
# first start downloads the vLLM image (~10 GB) plus model weights
npm run node`}</pre>
        </div>
      </Panel>
    );
  }

  const n = view?.node;
  const current = view?.jobs.find((j) => j.state === "RUNNING" || j.state === "STARTING" || j.state === "ASSIGNED") ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] uppercase tracking-[0.12em] text-chalk/50">
        <span>Node</span>
        <select value={nodeId ?? ""} onChange={(e) => setNodeId(e.target.value)} className="rounded-[6px] border border-chalk/15 bg-ink px-2 py-1 text-chalk">
          {nodes.map((x) => (
            <option key={x.nodeId} value={x.nodeId}>
              {x.nodeId} · {x.state}
            </option>
          ))}
          {nodeId && !nodes.some((x) => x.nodeId === nodeId) && <option value={nodeId}>{nodeId}</option>}
        </select>
        {n && <span className={stateTone(n.state)}>{n.state}</span>}
        {n?.gpu?.mock && <Tag tone="warn">mock node</Tag>}
        {view && <span className="ml-auto">as of {new Date(view.asOf).toLocaleTimeString()}</span>}
      </div>
      {err && <Panel><span className="font-mono text-[12px] text-warn">{err}</span></Panel>}
      {n && view && (
        <>
          <Panel title="Status">
            <div className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-4">
              <Metric k="State" v={<span className={stateTone(n.state)}>{n.state}</span>} sub={`heartbeat ${Math.round((Date.now() - n.lastHeartbeatAt) / 1000)} s ago`} big />
              <Metric k={<span>GPU <Tag>reported</Tag></span>} v={<span className="text-[18px]">{n.gpu ? n.gpu.model : "none"}</span>} sub={n.gpu ? `${n.gpu.count} × ${gb(n.gpu.vramTotalMb)} via ${n.gpu.source}` : undefined} />
              <Metric k={<span>Load <Tag>reported</Tag></span>} v={n.telemetry ? `${Math.round(n.telemetry.load * 100)}%` : "—"} sub={n.telemetry?.gpuUtilPct != null ? `GPU ${n.telemetry.gpuUtilPct}% · ${n.telemetry.temperatureC ?? "—"} °C` : "no GPU telemetry"} />
              <Metric k={<span>VRAM <Tag>reported</Tag></span>} v={n.telemetry?.vramUsedMb != null && n.telemetry.vramTotalMb ? `${gb(n.telemetry.vramUsedMb)}` : "—"} sub={n.telemetry?.vramTotalMb ? `of ${gb(n.telemetry.vramTotalMb)}` : undefined} />
              <Metric k="Current model" v={<span className="text-[18px]">{current?.model ?? n.loadedModels[0] ?? (n.supportedModels[0] ? `${n.supportedModels[0]} (cold)` : "—")}</span>} sub={current ? `job ${current.jobId.slice(0, 12)}… ${current.state}` : "idle"} />
              <Metric k="Jobs today" v={fmtInt(today?.jobs ?? 0)} sub={`${fmtInt(today?.tokens ?? 0)} tokens · ${((today?.computeMs ?? 0) / 1000).toFixed(1)} s compute`} />
              <Metric k="Uptime" v={n.uptimePct == null ? UNKNOWN : `${n.uptimePct.toFixed(1)}%`} sub="since registration, coordinator-measured" />
              <Metric k="Compute class" v={n.benchmark.computeClass ?? (n.benchmark.basis === "coordinator-timed" ? (n.gpu?.mock ? "MOCK" : "—") : "PENDING")} sub={n.benchmark.score == null ? "benchmark job pending" : `${n.benchmark.score} tok/s on ${n.benchmark.model ?? "?"} · coordinator-timed`} />
              <Metric k="Reliability" v={`${n.reputation}/100`} sub={`${n.measured.jobsCompleted} completed · ${n.measured.jobsFailed} failed · ${n.measured.jobsTimedOut} timed out`} tone={n.reputation >= 70 ? "ok" : n.reputation >= 40 ? "warn" : "bad"} />
            </div>
          </Panel>

          <Panel title="Earnings · ledger" right={<span>{view.earnings.basis}</span>}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-4">
              <Metric k="Accrued (owed)" v={view.earnings.events ? `$${view.earnings.accruedUsd.toFixed(6)}` : UNKNOWN} sub="provider share of priced receipts" />
              <Metric k="Settled (paid)" v={`$${view.earnings.settledUsd.toFixed(6)}`} sub="no payouts have run" tone="muted" />
              <Metric k="Receipts" v={fmtInt(view.earnings.events)} sub="COMPUTE_PROVIDER_EARNED events" />
              <Metric k="Ask" v={n.askUsdPer1MTokens == null ? "list price" : `$${n.askUsdPer1MTokens.toFixed(2)} / 1M`} sub="BRAIN_NODE_ASK_USD_PER_1M" />
            </div>
            <p className="mt-4 max-w-[720px] font-mono text-[11px] leading-relaxed text-chalk/40">
              Accrued is the sum of the provider share of every priced receipt issued for this node, at the network list price in force when the job ran. It is a ledger balance, not a projection. Settlement to a wallet is a planned interface; until it exists Settled stays 0.
            </p>
          </Panel>

          <div className="grid gap-6 md:grid-cols-2">
            <Panel title="Load · last heartbeats" right={<span>reported by node</span>}>
              <Spark samples={n.history} pick={(s) => s.load * 100} unit="%" max={100} />
            </Panel>
            <Panel title="GPU utilization" right={<span>reported by node</span>}>
              <Spark samples={n.history} pick={(s) => s.gpuUtilPct} unit="%" max={100} />
            </Panel>
            <Panel title="VRAM used" right={<span>reported by node</span>}>
              <Spark samples={n.history} pick={(s) => (s.vramUsedMb == null ? null : s.vramUsedMb / 1024)} unit=" GB" max={n.gpu?.vramTotalMb ? n.gpu.vramTotalMb / 1024 : undefined} />
            </Panel>
            <Panel title="Speed per job" right={<span>coordinator-timed</span>}>
              <Bars values={n.measured.tokPerSec} unit=" tok/s" />
            </Panel>
          </div>

          <Panel title="Details">
            <NodeDetail n={n} />
          </Panel>

          <Panel title="Recent jobs" right={<span>{view.jobs.length} shown</span>}>
            {view.jobs.length === 0 ? (
              <span className="font-mono text-[12px] text-chalk/45">No jobs have been routed to this node yet.</span>
            ) : (
              <div className="space-y-3">
                {view.jobs.map((j) => (
                  <div key={j.jobId} className="rounded-[10px] border border-chalk/10 bg-ink/30 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11.5px]">
                      <span className="flex flex-wrap items-center gap-2 text-chalk">
                        {j.model} {kindTag(j.kind)} <VerificationTag job={j} />
                      </span>
                      <span className="flex items-center gap-3 text-chalk/55">
                        <span>{new Date(j.createdAt).toLocaleTimeString()}</span>
                        <span className={stateTone(j.state)}>{j.state}</span>
                        {j.tokenUsage && <span>{j.tokenUsage.completion} tok</span>}
                        {j.computeDurationMs != null && <span>{(j.computeDurationMs / 1000).toFixed(2)} s</span>}
                        {j.finalCost && <span>${j.finalCost.amount.toFixed(6)}</span>}
                        {j.receiptId && (
                          <Link href={`/receipt/${j.receiptId}`} className="underline decoration-chalk/25 underline-offset-4 hover:text-chalk">
                            receipt
                          </Link>
                        )}
                      </span>
                    </div>
                    <div className="mt-2">
                      <JobPipeline job={j} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function Spark({ samples, pick, unit, max }: { samples: TelemetrySample[]; pick: (s: TelemetrySample) => number | null; unit: string; max?: number }) {
  const pts = samples.map((s) => pick(s));
  const have = pts.filter((x): x is number => x != null);
  if (have.length < 2) return <div className="flex h-[96px] items-center font-mono text-[12px] text-chalk/40">{have.length === 0 ? "No samples for this metric" : "Collecting samples"}</div>;
  const top = max ?? Math.max(1, ...have) * 1.1;
  const w = 320;
  const h = 96;
  const step = w / Math.max(1, pts.length - 1);
  const d = pts.map((v, i) => (v == null ? null : `${(i * step).toFixed(1)},${(h - (Math.min(v, top) / top) * (h - 8) - 4).toFixed(1)}`)).filter(Boolean);
  const last = have[have.length - 1];
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-[96px] w-full" preserveAspectRatio="none" aria-label="sparkline">
        <polyline fill="none" stroke="currentColor" strokeWidth="1.5" className="text-chalk/70" points={d.join(" ")} />
      </svg>
      <div className="mt-2 flex justify-between font-mono text-[10.5px] text-chalk/40">
        <span>{samples.length} heartbeats · {Math.round((samples[samples.length - 1].at - samples[0].at) / 60_000)} min</span>
        <span className="text-chalk/70">
          now {last.toFixed(unit === "%" ? 0 : 1)}
          {unit}
        </span>
      </div>
    </div>
  );
}

function Bars({ values, unit }: { values: number[]; unit: string }) {
  if (!values.length) return <div className="flex h-[96px] items-center font-mono text-[12px] text-chalk/40">No completed jobs yet</div>;
  const top = Math.max(...values) * 1.1;
  return (
    <div>
      <div className="flex h-[96px] items-end gap-[2px]">
        {values.slice(-60).map((v, i) => (
          <div key={i} className={cx("flex-1 rounded-t-[2px] bg-chalk/60")} style={{ height: `${Math.max(2, (v / top) * 100)}%` }} title={`${v.toFixed(1)}${unit}`} />
        ))}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10.5px] text-chalk/40">
        <span>last {Math.min(60, values.length)} jobs</span>
        <span className="text-chalk/70">
          latest {values[values.length - 1].toFixed(0)}
          {unit}
        </span>
      </div>
    </div>
  );
}
