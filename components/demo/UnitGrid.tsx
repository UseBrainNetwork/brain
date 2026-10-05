"use client";

import { motion } from "motion/react";
import { useMemo } from "react";
import type { DistributedJob } from "@/domain/types";
import { cx } from "@/lib/format";

/** One cell per (index, replica) slot showing the latest attempt's state. */
export function UnitGrid({ job }: { job: DistributedJob }) {
  // Latest attempt per (index, replica) slot.
  const slots = useMemo(() => {
    const m = new Map<string, DistributedJob["units"][number]>();
    for (const u of job.units) {
      const k = `${u.index}:${u.replica}`;
      const cur = m.get(k);
      if (!cur || u.attempt > cur.attempt) m.set(k, u);
    }
    return [...m.values()].sort((a, b) => a.index - b.index || a.replica - b.replica);
  }, [job.units]);
  return (
    <div className="flex flex-wrap gap-1">
      {slots.map((u) => (
        <motion.span
          key={`${u.index}:${u.replica}`}
          layout
          title={`${u.label}${u.replica ? "′" : ""} → ${u.nodeId} · ${u.status}`}
          className={cx(
            "grid h-6 min-w-6 place-items-center rounded-[3px] px-1 text-[9px] font-semibold",
            u.status === "verified" ? "bg-ok text-ink" : u.status === "computing" ? "bg-signal text-white" : u.status === "returned" ? "bg-warn text-ink" : u.status === "mismatch" || u.status === "lost" || u.status === "failed" ? "bg-signal/30 text-signal" : "bg-chalk/[0.08] text-chalk/60",
          )}
        >
          {u.label}
          {u.replica ? "′" : ""}
        </motion.span>
      ))}
    </div>
  );
}
