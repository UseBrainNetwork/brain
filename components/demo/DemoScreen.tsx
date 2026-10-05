"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Odometer, Prov } from "@/components/ui";
import type { DistributedJob, WorkloadSize } from "@/domain/types";
import { cx, fmtInt } from "@/lib/format";
import { setMode, useMode } from "@/network/realtime/mode";
import { realStore, useReal, type RealFeedItem } from "@/network/realtime/real";
import { Topology } from "./Topology";
import { UnitGrid } from "./UnitGrid";

/** /demo — the recording screen. Real nodes, real jobs, real verification; nothing simulated. */

const hhmmss = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour12: false });

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.14em] text-chalk/40">{k}</div>
      <div className="num mt-1 text-[22px] leading-none text-chalk">{v}</div>
      {sub && <div className="mt-1 text-[10px] text-chalk/35">{sub}</div>}
    </div>
  );
}

const toneClass: Record<RealFeedItem["tone"], string> = {
  neutral: "text-chalk/70",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-signal",
  signal: "text-signal",
};

function Feed({ items }: { items: RealFeedItem[] }) {
  return (
    <ol className="space-y-[7px] text-[11.5px]">
      <AnimatePresence initial={false}>
        {items.slice(0, 18).map((f) => (
          <motion.li key={f.key} initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} className="grid grid-cols-[62px_1fr] gap-3">
            <span className="text-chalk/35">{hhmmss(f.at)}</span>
            <span className="min-w-0">
              <span className={cx("block truncate font-medium tracking-[0.04em]", toneClass[f.tone])}>{f.title}</span>
              <span className="block truncate text-chalk/45">{f.detail}</span>
            </span>
          </motion.li>
        ))}
      </AnimatePresence>
      {items.length === 0 && <li className="text-chalk/30">Waiting for real events…</li>}
    </ol>
  );
}

function JobPanel({ job }: { job: DistributedJob }) {
  const done = job.status === "completed";
  const failed = job.status === "failed";
  const t = job.totals;
  return (
    <motion.div layout className={cx("rounded-[14px] border p-4", done ? "border-ok/40 bg-ok/[0.06]" : failed ? "border-signal/40 bg-signal/[0.06]" : "border-chalk/10 bg-chalk/[0.03]")}>
      <div className="flex items-baseline justify-between">
        <div className="text-[12px] tracking-[0.08em]">
          <span className="text-chalk/50">JOB</span> <span className="text-chalk">#{job.id}</span>
          <span className="ml-3 text-chalk/40">{job.workload.label}</span>
          <span className="ml-2 text-chalk/30">
            {job.workload.unitDims.m}×{job.workload.unitDims.n}×{job.workload.unitDims.k} u32 · {job.size}
          </span>
        </div>
        <div className={cx("text-[12px] font-semibold tracking-[0.12em]", done ? "text-ok" : failed ? "text-signal" : "text-signal")}>
          {done ? "JOB COMPLETE ✓" : failed ? "JOB FAILED ✕" : job.status.toUpperCase()}
          {!done && !failed && <span className="animate-blink">…</span>}
        </div>
      </div>
      <div className="mt-3">
        <UnitGrid job={job} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-6">
        <Stat k="Nodes used" v={String(t.nodesUsed || job.nodeIds.length)} />
        <Stat k="Real WebGPU" v="YES" sub="server-verified" />
        <Stat k="Work units" v={String(t.workUnits)} sub={job.redundancy === 2 ? "×2 replicas" : undefined} />
        <Stat k="Verified" v={`${t.verified} / ${t.workUnits * job.redundancy}`} sub={t.reassigned ? `${t.reassigned} reassigned` : t.failed ? `${t.failed} rejected` : undefined} />
        <Stat k="Total compute" v={`${fmtInt(t.computeUnits)} u`} />
        <Stat k="Latency" v={t.latencyMs != null ? `${(t.latencyMs / 1000).toFixed(2)}s` : `${((Date.now() - job.createdAt) / 1000).toFixed(1)}s`} sub={t.latencyMs != null ? "request → verified" : "elapsed"} />
      </div>
    </motion.div>
  );
}

export function DemoScreen() {
  const nodes = useReal((r) => r.nodes);
  const jobs = useReal((r) => r.jobs);
  const feed = useReal((r) => r.feed);
  const summary = useReal((r) => r.summary);
  const connected = useReal((r) => r.connected);
  const siteMode = useMode();
  const nodeList = useMemo(() => Object.values(nodes), [nodes]);
  const count = nodeList.length;
  const job = jobs[0] ?? null;
  const running = Boolean(job && job.status !== "completed" && job.status !== "failed");

  const [controls, setControls] = useState(false);
  const [size, setSize] = useState<WorkloadSize>("medium");
  const [perNode, setPerNode] = useState(4);
  const [redundancy, setRedundancy] = useState<1 | 2>(1);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState("");
  useEffect(() => {
    const t = setInterval(() => setClock(hhmmss(Date.now())), 500);
    return () => clearInterval(t);
  }, []);

  // Flash on count change.
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    setFlash((f) => f + 1);
  }, [count]);

  async function run() {
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ size, unitsPerNode: perNode, redundancy }) });
      const j = await r.json();
      if (!r.ok) setErr(j.error === "no_real_nodes" ? "No real nodes online. Join from a device first." : j.error === "job_in_progress" ? "A job is already running." : String(j.error ?? "failed"));
      else void realStore.refresh(true);
    } catch {
      setErr("Server unreachable.");
    } finally {
      setBusy(false);
    }
  }

  const verifiedUnits = summary?.verifiedComputeUnits ?? 0;

  return (
    <div data-theme="dark" className="surface-dark relative flex h-dvh min-h-[640px] flex-col overflow-hidden font-mono">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-chalk/[0.08] px-6 py-4 md:px-8">
        <div className="flex items-baseline gap-4">
          <span className="font-sans text-[18px] font-semibold tracking-tight text-chalk">BRAIN</span>
          <span className="text-[11px] uppercase tracking-[0.16em] text-chalk/50">Live network</span>
          <span className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-ok">
            <span className={cx("inline-block size-[6px] bg-ok", connected && "animate-pulse-dot")} /> Real mode
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-[11px] text-chalk/40 md:inline">{clock}</span>
          <button type="button" onClick={() => setControls((v) => !v)} className="h-9 rounded-full px-3 text-[10.5px] uppercase tracking-[0.12em] text-chalk/50 ring-1 ring-inset ring-chalk/15 hover:text-chalk">
            Demo controls
          </button>
          <button
            type="button"
            disabled={busy || running || count === 0}
            onClick={() => void run()}
            className="h-9 rounded-full bg-signal px-5 font-sans text-[13px] font-semibold text-white transition hover:bg-signal-2 disabled:opacity-40"
          >
            {running ? "Running…" : "RUN TEST JOB"}
          </button>
        </div>
      </header>

      <AnimatePresence>
        {controls && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-b border-chalk/[0.08] bg-chalk/[0.02]">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-6 py-3 text-[10.5px] uppercase tracking-[0.1em] md:px-8">
              <div className="flex items-center gap-2">
                <span className="text-chalk/40">Workload</span>
                {(["small", "medium", "large"] as const).map((s) => (
                  <button key={s} type="button" onClick={() => setSize(s)} className={cx("rounded px-2 py-1", size === s ? "bg-chalk text-ink" : "text-chalk/60 ring-1 ring-inset ring-chalk/15")}>
                    {s}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-chalk/40">Units / node</span>
                {[1, 2, 4, 8].map((n) => (
                  <button key={n} type="button" onClick={() => setPerNode(n)} className={cx("rounded px-2 py-1", perNode === n ? "bg-chalk text-ink" : "text-chalk/60 ring-1 ring-inset ring-chalk/15")}>
                    {n}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-chalk/40">Redundancy</span>
                {([1, 2] as const).map((n) => (
                  <button key={n} type="button" onClick={() => setRedundancy(n)} className={cx("rounded px-2 py-1", redundancy === n ? "bg-chalk text-ink" : "text-chalk/60 ring-1 ring-inset ring-chalk/15")}>
                    {n === 1 ? "spot-check" : "2× replicas"}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-chalk/40">Rest of site</span>
                {(["demo", "real"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setMode(m)} className={cx("rounded px-2 py-1", siteMode === m ? "bg-chalk text-ink" : "text-chalk/60 ring-1 ring-inset ring-chalk/15")}>
                    {m === "demo" ? "demo data" : "real only"}
                  </button>
                ))}
              </div>
              <span className="text-chalk/35 normal-case tracking-normal">Larger workloads run longer because they do more arithmetic. Nothing here delays processing artificially.</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Body */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_1fr_320px]">
        {/* Left: counters */}
        <section className="flex flex-col justify-between border-b border-chalk/[0.08] p-6 lg:border-b-0 lg:border-r md:p-8">
          <div>
            <div className="relative">
              <motion.div key={flash} initial={{ opacity: 0.6 }} animate={{ opacity: 0 }} transition={{ duration: 1.2 }} className="pointer-events-none absolute -inset-4 rounded-2xl bg-ok/20 blur-xl" />
              <Odometer text={String(count)} className="relative text-[clamp(120px,16vw,200px)] font-medium leading-none text-chalk" fast />
            </div>
            <div className="mt-3 text-[12px] uppercase tracking-[0.2em] text-chalk/60">
              Real {count === 1 ? "node" : "nodes"} online <Prov p="live" className="align-middle" />
            </div>
            <div className="mt-10">
              <Odometer text={fmtInt(verifiedUnits)} className="text-[44px] font-medium leading-none text-chalk" />
              <div className="mt-2 text-[11px] uppercase tracking-[0.18em] text-chalk/50">Verified compute units</div>
            </div>
          </div>
          <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-5">
            <Stat k="Real jobs" v={summary ? String(summary.jobsCompleted) : "—"} />
            <Stat k="Work units" v={summary ? String(summary.workUnitsVerified) : "—"} />
            <Stat k="Capacity" v={summary ? fmtInt(summary.capacityScore) : "—"} sub="sum of verified scores" />
            <Stat k="Success rate" v={summary?.successRate == null ? "—" : `${(summary.successRate * 100).toFixed(1)}%`} />
          </div>
        </section>

        {/* Center: topology + job */}
        <section className="relative flex min-h-0 flex-col">
          <div className="relative min-h-0 flex-1">
            <Topology nodes={nodeList} job={job} className="absolute inset-0" />
          </div>
          <div className="px-4 pb-4 md:px-6">
            <AnimatePresence mode="popLayout">
              {job ? (
                <motion.div key={job.id} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <JobPanel job={job} />
                </motion.div>
              ) : (
                <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-[14px] border border-dashed border-chalk/10 p-4 text-[11px] uppercase tracking-[0.12em] text-chalk/35">
                  No job yet · {count > 0 ? "press RUN TEST JOB to split a real workload across the nodes above" : "join from a device to enable jobs"}
                </motion.div>
              )}
            </AnimatePresence>
            {err && <div className="mt-2 text-[11px] text-signal">{err}</div>}
          </div>
        </section>

        {/* Right: events */}
        <aside className="hidden min-h-0 flex-col border-l border-chalk/[0.08] p-6 lg:flex">
          <div className="mb-4 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-chalk/40">
            <span>Network events</span>
            <span>
              real only <Prov p="live" />
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_bottom,#000_80%,transparent)]">
            <Feed items={feed} />
          </div>
          <div className="mt-4 border-t border-chalk/[0.08] pt-3 text-[10px] uppercase tracking-[0.1em] text-chalk/30">
            Workload: parallel u32 matmul, server spot-checked · not model inference ·{" "}
            <Link href="/node" className="text-chalk/60 hover:text-chalk">
              /node
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
