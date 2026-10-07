"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { PublicInferenceJob } from "@/services/coordinator/jobs";
import type { PublicNativeNode } from "@/services/coordinator/registry";
import type { JobState } from "@/node/protocol";
import { cx, fmtInt } from "@/lib/format";
import { Metric, NO_DATA, Panel } from "@/components/economy/parts";
import { RequestFlow } from "@/components/network/RequestFlow";

/**
 * Brain Nodes (native agents) as the coordinator sees them, and the inference jobs flowing
 * through them. Every number is read from /api/coordinator/*; hardware figures carry the
 * REPORTED label because the node said them, the coordinator did not measure them.
 */
export const JOB_STATES: JobState[] = ["QUEUED", "MATCHING", "ASSIGNED", "STARTING", "RUNNING", "VERIFYING", "COMPLETED"];

export function useFleet(intervalMs = 5_000) {
  const [nodes, setNodes] = useState<PublicNativeNode[] | null>(null);
  const [jobs, setJobs] = useState<PublicInferenceJob[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [n, j] = await Promise.all([fetch("/api/coordinator/nodes").then((r) => r.json()), fetch("/api/coordinator/jobs?limit=12").then((r) => r.json())]);
        if (!alive) return;
        setNodes(n.nodes ?? []);
        setJobs(j.jobs ?? []);
      } catch {
        /* keep last good values */
      }
    };
    void load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return { nodes, jobs };
}

export const stateTone = (s: string) => (s === "ONLINE" || s === "COMPLETED" ? "text-ok" : s === "BUSY" || s === "RUNNING" || s === "STARTING" ? "text-signal" : s === "DEGRADED" || s === "DRAINING" || s === "QUEUED" ? "text-warn" : s === "FAILED" || s === "CANCELLED" || s === "OFFLINE" ? "text-chalk/40" : "text-chalk");

export const Tag = ({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warn" | "ok" }) => (
  <span className={cx("rounded-[4px] border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em]", tone === "warn" ? "border-warn/40 text-warn" : tone === "ok" ? "border-ok/40 text-ok" : "border-chalk/15 text-chalk/45")}>{children}</span>
);

export const gb = (mb: number | null | undefined) => (mb == null ? "—" : `${(mb / 1024).toFixed(mb >= 10_240 ? 0 : 1)} GB`);

export function JobPipeline({ job }: { job: PublicInferenceJob }) {
  const reached = new Set(job.history.map((h) => h.state));
  const failed = job.state === "FAILED" || job.state === "CANCELLED";
  return (
    <div className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.08em]">
      {JOB_STATES.map((s, i) => (
        <span key={s} className="flex items-center gap-1">
          <span className={cx(reached.has(s) ? (s === job.state ? "text-chalk" : "text-chalk/55") : "text-chalk/20")}>{s}</span>
          {i < JOB_STATES.length - 1 && <span className="text-chalk/15">→</span>}
        </span>
      ))}
      {failed && <span className="ml-1 text-signal">{job.state}</span>}
    </div>
  );
}

export function NativeFleet() {
  const { nodes, jobs } = useFleet();
  const [open, setOpen] = useState<string | null>(null);
  const stats = useMemo(() => {
    if (!nodes) return null;
    const live = nodes.filter((n) => n.state === "ONLINE" || n.state === "BUSY");
    const dayAgo = Date.now() - 86_400_000;
    const models = new Set(live.flatMap((n) => n.supportedModels));
    return {
      online: live.length,
      gpus: live.reduce((s, n) => s + (n.gpu?.count ?? 0), 0),
      vramMb: live.reduce((s, n) => s + (n.gpu?.vramTotalMb ?? 0) * (n.gpu?.count ?? 1), 0),
      mock: live.filter((n) => n.gpu?.mock).length,
      running: nodes.reduce((s, n) => s + n.activeJobs, 0),
      completed: nodes.reduce((s, n) => s + n.measured.jobsCompleted, 0),
      tokens: nodes.reduce((s, n) => s + n.measured.tokensGenerated, 0),
      computeMs: nodes.reduce((s, n) => s + n.measured.computeMs, 0),
      slots: live.reduce((s, n) => s + Math.max(0, (n.telemetry ? Math.round((1 - n.telemetry.load) * (n.activeJobs + 1)) : 1)), 0),
      utilization: live.length ? live.reduce((s, n) => s + (n.telemetry?.load ?? 0), 0) / live.length : null,
      models: [...models],
      recent24h: (jobs ?? []).filter((j) => j.createdAt > dayAgo).length,
    };
  }, [nodes, jobs]);

  if (!nodes || !stats) return <Panel title="Brain Nodes">{NO_DATA}</Panel>;

  return (
    <div className="space-y-6">
      <RequestFlow nodesOnline={stats.online} />
      <Panel title="Brain Nodes · native agents" right={<span>{stats.mock ? `${stats.mock} mock` : "coordinator records"}</span>}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-5">
          <Metric k="Nodes online" v={fmtInt(stats.online)} sub={`${nodes.length} registered`} tone={stats.online ? "ok" : "muted"} />
          <Metric k="GPUs online" v={fmtInt(stats.gpus)} sub="reported by nodes" />
          <Metric k="Total VRAM" v={stats.vramMb ? gb(stats.vramMb) : "—"} sub="reported" />
          <Metric k="Jobs running" v={fmtInt(stats.running)} />
          <Metric k="Jobs completed" v={fmtInt(stats.completed)} sub={`${fmtInt(stats.tokens)} tokens generated`} />
          <Metric k="Requests · 24h" v={fmtInt(stats.recent24h)} sub="last 12 shown below" />
          <Metric k="Compute" v={stats.computeMs ? `${(stats.computeMs / 1000).toFixed(1)} s` : "—"} sub="coordinator-timed" />
          <Metric k="Utilization" v={stats.utilization == null ? "—" : `${Math.round(stats.utilization * 100)}%`} sub="mean slot load" />
          <Metric k="Models" v={fmtInt(stats.models.length)} sub={stats.models.join(", ") || "none served"} />
          <Metric k="Hardware" v={<span className="text-[14px]">REPORTED</span>} sub="not measured by BRAIN" tone="muted" />
        </div>
        {nodes.length === 0 && (
          <div className="mt-6 rounded-[10px] border border-chalk/10 bg-ink/40 p-4 font-mono text-[12px] leading-relaxed text-chalk/55">
            No Brain Nodes are connected to this coordinator. Run one: <span className="text-chalk">BRAIN_NODE_MODE=mock npm run node</span> (any machine) or <span className="text-chalk">npm run node</span> on an NVIDIA machine with Docker.
          </div>
        )}
        {nodes.length > 0 && (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-left font-mono text-[12px]">
              <thead className="text-[10px] uppercase tracking-[0.12em] text-chalk/40">
                <tr>
                  {["Node", "State", "GPU", "VRAM", "Class", "Region", "Load", "Uptime", "Jobs", "Reliability"].map((h) => (
                    <th key={h} className="pb-2 pr-4 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-chalk/80">
                {nodes.map((n) => (
                  <FleetRow key={n.nodeId} n={n} open={open === n.nodeId} onToggle={() => setOpen(open === n.nodeId ? null : n.nodeId)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Inference jobs · native nodes" right={<span>request → router → node → response</span>}>
        {!jobs?.length ? (
          <div className="font-mono text-[12px] text-chalk/45">No jobs yet. Send one: <span className="text-chalk">npm run demo:request</span></div>
        ) : (
          <div className="space-y-3">
            {jobs.map((j) => (
              <div key={j.jobId} className="rounded-[10px] border border-chalk/10 bg-ink/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11.5px]">
                  <span className="text-chalk">{j.model} {j.kind === "benchmark" && <Tag>benchmark</Tag>}</span>
                  <span className="flex items-center gap-3 text-chalk/55">
                    {j.assignedNode && <Link href={`/provider?node=${j.assignedNode}`} className="underline decoration-chalk/25 underline-offset-4 hover:text-chalk">{j.assignedNode}</Link>}
                    <span className={stateTone(j.state)}>{j.state}</span>
                    {j.tokenUsage && <span>{j.tokenUsage.completion} tok</span>}
                    {j.computeDurationMs != null && <span>{(j.computeDurationMs / 1000).toFixed(2)} s</span>}
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
                {j.failureReason && <div className="mt-1 font-mono text-[10.5px] text-warn">{j.failureReason}{j.history.at(-1)?.note ? ` · ${j.history.at(-1)!.note}` : ""}</div>}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function FleetRow({ n, open, onToggle }: { n: PublicNativeNode; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="cursor-pointer border-t border-chalk/5 hover:bg-chalk/[0.03]" onClick={onToggle}>
        <td className="py-2 pr-4 text-chalk">{n.nodeId}</td>
        <td className={cx("py-2 pr-4", stateTone(n.state))}>{n.state}</td>
        <td className="py-2 pr-4">
          <span className="mr-2">{n.gpu?.model ?? "—"}</span>
          {n.gpu?.mock && <Tag tone="warn">mock</Tag>}
        </td>
        <td className="py-2 pr-4">{gb(n.gpu?.vramTotalMb)}</td>
        <td className="py-2 pr-4">{n.benchmark.computeClass ?? (n.benchmark.basis === "coordinator-timed" ? (n.gpu?.mock ? "mock" : "—") : "benchmarking")}</td>
        <td className="py-2 pr-4">{n.region ?? "—"}</td>
        <td className="py-2 pr-4">{n.telemetry ? `${Math.round(n.telemetry.load * 100)}%` : "—"}</td>
        <td className="py-2 pr-4">{n.uptimePct == null ? "—" : `${n.uptimePct.toFixed(1)}%`}</td>
        <td className="py-2 pr-4">{n.measured.jobsCompleted}{n.measured.jobsFailed + n.measured.jobsTimedOut ? ` / ${n.measured.jobsFailed + n.measured.jobsTimedOut} failed` : ""}</td>
        <td className="py-2 pr-4">{n.reputation}/100</td>
      </tr>
      {open && (
        <tr className="border-t border-chalk/5 bg-ink/30">
          <td colSpan={10} className="p-4">
            <NodeDetail n={n} />
          </td>
        </tr>
      )}
    </>
  );
}

export function NodeDetail({ n }: { n: PublicNativeNode }) {
  const t = n.telemetry;
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
      <Metric k={<span>GPU <Tag>reported</Tag></span>} v={<span className="text-[15px]">{n.gpu ? `${n.gpu.count > 1 ? `${n.gpu.count}× ` : ""}${n.gpu.model}` : "none"}</span>} sub={n.gpu ? `via ${n.gpu.source}` : undefined} />
      <Metric k="VRAM" v={<span className="text-[15px]">{t?.vramUsedMb != null && t.vramTotalMb ? `${gb(t.vramUsedMb)} / ${gb(t.vramTotalMb)}` : gb(n.gpu?.vramTotalMb)}</span>} sub="reported" />
      <Metric k="Region" v={<span className="text-[15px]">{n.region ?? "not set"}</span>} sub="operator label" />
      <Metric k="Status" v={<span className={cx("text-[15px]", stateTone(n.state))}>{n.state}</span>} sub={`heartbeat ${Math.round((Date.now() - n.lastHeartbeatAt) / 1000)} s ago`} />
      <Metric k="Utilization" v={<span className="text-[15px]">{t?.gpuUtilPct != null ? `${t.gpuUtilPct}%` : "—"}</span>} sub={t ? `${t.activeJobs} active job${t.activeJobs === 1 ? "" : "s"}` : undefined} />
      <Metric k="Uptime" v={<span className="text-[15px]">{n.uptimePct == null ? "—" : `${n.uptimePct.toFixed(1)}%`}</span>} sub="heartbeats observed ÷ expected" />
      <Metric k="Jobs completed" v={<span className="text-[15px]">{n.measured.jobsCompleted}</span>} sub={`${n.measured.tokensGenerated} tokens · ${n.measured.tokPerSec.length ? `${median(n.measured.tokPerSec).toFixed(0)} tok/s median` : "speed unmeasured"}`} />
      <Metric k="Reliability" v={<span className="text-[15px]">{n.reputation}/100</span>} sub="coordinator-measured; not transferable" />
      <Metric k="Benchmark" v={<span className="text-[15px]">{n.benchmark.score == null ? "pending" : `${n.benchmark.score} tok/s`}</span>} sub={n.benchmark.score == null ? "coordinator sends a timed job on join" : `${n.benchmark.computeClass ?? (n.gpu?.mock ? "mock, unclassified" : "unclassified")} · ${n.benchmark.model ?? ""} · coordinator-timed`} />
      <div className="col-span-2 md:col-span-4">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-chalk/45">Supported models</div>
        <div className="mt-1 flex flex-wrap gap-2 font-mono text-[11.5px] text-chalk/75">
          {n.supportedModels.length ? n.supportedModels.map((m) => (
            <span key={m} className="rounded-[6px] border border-chalk/10 px-2 py-1">
              {m} {n.loadedModels.includes(m) ? <Tag tone="ok">loaded</Tag> : <Tag>cold</Tag>}
            </span>
          )) : <span className="text-chalk/40">none accepted</span>}
        </div>
        <div className="mt-3 font-mono text-[11px] text-chalk/45">
          <Link href={`/provider?node=${n.nodeId}`} className="underline decoration-chalk/25 underline-offset-4 hover:text-chalk">Provider dashboard →</Link>
        </div>
      </div>
    </div>
  );
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
