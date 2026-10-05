"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import type { ComputeJob, JobStatus } from "@/domain/types";
import { Prov } from "@/components/ui";
import { useNetwork } from "@/network/realtime/store";
import { cx, fmtMs } from "@/lib/format";
import { stageAt, useNow } from "./Explorer";

const STAGES: JobStatus[] = ["submitted", "split", "assigned", "executing", "verifying", "merged", "completed"];
const SHOWN = 14;

function cellState(stage: JobStatus, i: number, n: number, now: number, j: ComputeJob) {
  if (stage === "failed") return "failed";
  if (stage === "completed" || stage === "merged") return "done";
  if (stage === "verifying") return "verify";
  if (stage === "executing") {
    const ex = j.lifecycle.find((e) => e.stage === "executing")?.at ?? now;
    const vf = j.lifecycle.find((e) => e.stage === "verifying")?.at ?? ex + 1500;
    const p = Math.min(1, (now - ex) / Math.max(1, vf - ex));
    return i / n < p ? "run" : "wait";
  }
  return stage === "assigned" ? "wait" : "idle";
}

function Block({ j, now }: { j: ComputeJob; now: number }) {
  const stage = stageAt(j, now);
  const failed = stage === "failed";
  const done = stage === "completed";
  const reached = failed ? j.lifecycle.filter((e) => e.stage !== "failed" && e.at <= now).length : STAGES.indexOf(stage) + 1;
  const n = Math.max(1, j.nodeIds.length);
  const age = Math.max(0, Math.round((now - j.submittedAt) / 1000));
  const live = j.provenance === "live";

  return (
    <Link
      href={`/explorer/job/${j.id}`}
      className={cx(
        "group relative flex h-[188px] w-[156px] shrink-0 flex-col rounded-[14px] p-3.5 transition-colors",
        "bg-[#1a1a19] ring-1 ring-inset hover:bg-[#222220]",
        live ? "ring-ok/50" : failed ? "ring-signal/40" : "ring-white/[0.07]",
      )}
    >
      <div className="flex items-center justify-between font-mono text-[11px]">
        <span className="font-semibold text-chalk">#{j.id}</span>
        <span className="text-chalk/35">{age}s</span>
      </div>
      <div className="mt-0.5 truncate font-mono text-[10.5px] text-chalk/45">{j.model}</div>

      <div className="mt-3 grid grid-cols-6 gap-[3px]">
        {Array.from({ length: n }, (_, i) => {
          const c = cellState(stage, i, n, now, j);
          return (
            <span
              key={i}
              className={cx(
                "aspect-square rounded-[2px] transition-colors duration-300",
                c === "done" && "bg-ok",
                c === "run" && "bg-signal",
                c === "verify" && "animate-pulse bg-signal/70",
                c === "wait" && "bg-chalk/20",
                c === "idle" && "bg-chalk/[0.07]",
                c === "failed" && "bg-transparent ring-1 ring-inset ring-signal/70",
              )}
            />
          );
        })}
      </div>

      <div className="mt-auto">
        <div className="flex items-baseline justify-between">
          <span className="num text-[22px] font-medium leading-none text-chalk">
            {j.computeUnits}
            <span className="ml-0.5 text-[11px] text-chalk/40">u</span>
          </span>
          <span className="font-mono text-[10.5px] text-chalk/45">{done && j.latencyMs ? fmtMs(j.latencyMs) : `${n} node${n > 1 ? "s" : ""}`}</span>
        </div>
        <div className="mt-2.5 flex gap-[3px]">
          {STAGES.map((s, i) => (
            <span
              key={s}
              className={cx(
                "h-[3px] flex-1 rounded-full transition-colors duration-300",
                i < reached ? (failed ? "bg-signal/60" : done ? "bg-ok" : "bg-signal") : failed && i === reached ? "bg-signal" : "bg-chalk/10",
              )}
            />
          ))}
        </div>
        <div className={cx("mt-2 font-mono text-[10px] font-semibold uppercase tracking-[0.06em]", done ? "text-ok" : failed ? "text-signal" : "text-warn")}>
          {done ? "verified" : stage}
          {live && <span className="ml-1.5 text-ok">· live</span>}
        </div>
      </div>
    </Link>
  );
}

export function JobChain({ className }: { className?: string }) {
  const jobs = useNetwork((s) => s.jobs).slice(0, SHOWN);
  const now = useNow(200);

  return (
    <div className={cx("relative", className)}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 font-mono text-[11px] text-chalk/45">
        <span className="flex items-center gap-2 uppercase tracking-[0.08em]">
          Job chain <Prov p="simulated" />
        </span>
        <span className="flex flex-wrap items-center gap-4">
          <span className="flex items-center gap-1.5"><i className="size-2 rounded-[2px] bg-chalk/20" />assigned</span>
          <span className="flex items-center gap-1.5"><i className="size-2 rounded-[2px] bg-signal" />executing</span>
          <span className="flex items-center gap-1.5"><i className="size-2 rounded-[2px] bg-ok" />verified</span>
          <span className="flex items-center gap-1.5"><i className="size-2 rounded-[2px] ring-1 ring-inset ring-signal" />failed</span>
          <span className="hidden sm:inline">1 cell = 1 node · newest ←</span>
        </span>
      </div>
      <div className="relative -mx-5 overflow-hidden px-5 md:-mx-10 md:px-10 [mask-image:linear-gradient(90deg,#000_85%,transparent)]">
        <div className="absolute inset-x-0 top-1/2 h-px bg-chalk/10" />
        <div className="relative flex h-[188px] gap-3">
          {!now && <div className="font-mono text-[12px] text-chalk/40">Connecting to the job stream…</div>}
          <AnimatePresence initial={false} mode="popLayout">
            {now > 0 &&
              jobs.map((j) => (
                <motion.div
                  key={j.id}
                  layout
                  initial={{ opacity: 0, x: -40, scale: 0.94 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: "spring", stiffness: 260, damping: 30 }}
                >
                  <Block j={j} now={now} />
                </motion.div>
              ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
