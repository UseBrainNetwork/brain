"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ComputeJob, JobStatus } from "@/domain/types";
import { useNetwork } from "@/network/realtime/store";
import { cx, fmtMs } from "@/lib/format";

const STAGE_COLORS: Partial<Record<JobStatus, string>> = {
  split: "bg-chalk/30",
  assigned: "bg-chalk/45",
  executing: "bg-signal",
  verifying: "bg-ok",
  merged: "bg-chalk/70",
};

const WINDOW = 6000;

/** Gantt view of recent jobs: each bar is a real lifecycle (stage timestamps), on a scrolling time axis. */
export function JobWaterfall({ rows = 14, className }: { rows?: number; className?: string }) {
  const jobs = useNetwork((s) => s.jobs);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setNow(Date.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const visible = jobs.filter((j) => now - j.submittedAt < WINDOW + 3000).slice(0, rows);
  const x = (t: number) => Math.max(0, Math.min(100, ((t - (now - WINDOW)) / WINDOW) * 100));

  return (
    <div className={cx("font-mono text-[11px]", className)}>
      <div className="grid grid-cols-[92px_1fr_64px] gap-3 border-b border-chalk/10 pb-2 text-chalk/40 md:grid-cols-[110px_130px_1fr_70px]">
        <span>job</span>
        <span className="hidden md:block">model</span>
        <span className="flex justify-between">
          <span>−6s</span>
          <span>−3s</span>
          <span>now</span>
        </span>
        <span className="text-right">latency</span>
      </div>
      <div className="relative">
        {visible.map((j) => (
          <Row key={j.id} j={j} now={now} x={x} />
        ))}
        {!visible.length && <div className="py-8 text-chalk/40">Waiting for jobs…</div>}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-chalk/45">
        {(["split", "assigned", "executing", "verifying", "merged"] as JobStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={cx("h-1.5 w-3 rounded-sm", STAGE_COLORS[s])} /> {s}
          </span>
        ))}
      </div>
    </div>
  );
}

function Row({ j, now, x }: { j: ComputeJob; now: number; x: (t: number) => number }) {
  // Only reveal stages whose timestamp has passed, so bars grow in real time.
  const stages = j.lifecycle.filter((s) => s.at <= now);
  const done = j.lifecycle.find((s) => s.stage === "completed" || s.stage === "failed");
  const finished = done && done.at <= now;
  return (
    <Link href={`/explorer/job/${j.id}`} className="grid grid-cols-[92px_1fr_64px] items-center gap-3 border-b border-chalk/[0.05] py-[7px] hover:bg-chalk/[0.03] md:grid-cols-[110px_130px_1fr_70px]">
      <span className={cx(j.provenance === "live" ? "text-ok" : "text-chalk/80")}>#{j.id}</span>
      <span className="hidden truncate text-chalk/45 md:block">{j.model}</span>
      <span className="relative h-2.5">
        <span className="absolute inset-y-[4px] left-0 right-0 bg-chalk/[0.04]" />
        {stages.map((s, i) => {
          const end = stages[i + 1]?.at ?? (finished ? s.at : now);
          const color = STAGE_COLORS[s.stage];
          if (!color) return null;
          return <span key={s.stage} className={cx("absolute inset-y-0 rounded-[1px]", color)} style={{ left: `${x(s.at)}%`, width: `${Math.max(0.4, x(end) - x(s.at))}%` }} />;
        })}
      </span>
      <span className={cx("text-right", finished ? "text-chalk/70" : "text-signal")}>{finished ? fmtMs(j.latencyMs ?? 0) : "…"}</span>
    </Link>
  );
}
