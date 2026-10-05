"use client";

import { Counter, Prov } from "@/components/ui";
import type { Provenance } from "@/domain/types";
import { useNetwork } from "@/network/realtime/store";
import { useSim } from "@/network/realtime/mode";
import { useReal } from "@/network/realtime/real";
import { cx, fmtCompact, fmtInt, fmtUsd } from "@/lib/format";

interface MetricDef {
  label: string;
  value: number | null;
  format: (n: number) => string;
  prov: Provenance;
  placeholder?: string;
  accent?: boolean;
}

export function useMetricDefs(): MetricDef[] {
  const m = useNetwork((s) => s.metrics);
  const sim = useSim();
  const real = useReal((r) => r.summary);
  if (!sim) {
    // Real only: every figure here comes from this server's registry and verified jobs.
    return [
      { label: "Nodes online", value: m.liveNodes, format: fmtInt, prov: "live", accent: true },
      { label: "Available memory", value: m.availableMemoryTb, format: (n) => `${n.toFixed(2)} TB`, prov: "live" },
      { label: "Capacity score", value: real?.capacityScore ?? m.capacityScore, format: fmtInt, prov: "live" },
      { label: "Jobs completed", value: real?.jobsCompleted ?? 0, format: fmtInt, prov: "live" },
      { label: "Work units verified", value: real?.workUnitsVerified ?? 0, format: fmtInt, prov: "live" },
      { label: "Verified compute", value: real?.verifiedComputeUnits ?? 0, format: (n) => fmtCompact(n, 2), prov: "live" },
      { label: "Success rate", value: real?.successRate ?? null, format: (n) => `${(n * 100).toFixed(0)}%`, prov: "live", placeholder: "no jobs yet" },
    ];
  }
  return [
    { label: "GPUs online", value: m.gpusOnline, format: fmtInt, prov: "simulated", accent: true },
    { label: "Available memory", value: m.availableMemoryTb, format: (n) => `${n.toFixed(1)} TB`, prov: "simulated" },
    { label: "Inferences today", value: m.inferencesToday, format: (n) => fmtCompact(n, 2), prov: "simulated" },
    { label: "Creator rewards today", value: m.creatorRewardsTodayUsd, format: (n) => fmtUsd(n), prov: "simulated" },
    { label: "Paid to compute providers", value: m.paidToProvidersTodayUsd, format: (n) => fmtUsd(n), prov: "simulated" },
    { label: "Avg cost / 1M tokens", value: m.avgCostPer1MTokensUsd, format: (n) => `$${n.toFixed(2)}`, prov: "simulated", placeholder: "$0.XX" },
    { label: "Network uptime", value: m.uptimePct, format: (n) => `${n.toFixed(2)}%`, prov: "simulated" },
  ];
}

export function MetricsStrip({ className, tone = "dark" }: { className?: string; tone?: "dark" | "light" }) {
  const defs = useMetricDefs();
  return (
    <div className={cx("grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7", className)}>
      {defs.map((d, i) => (
        <div
          key={d.label}
          className={cx(
            "flex min-w-0 flex-col justify-between gap-3 px-4 py-4 md:px-5",
            tone === "dark" ? "border-chalk/[0.08]" : "border-ink/10",
            "border-t xl:border-t-0",
            i > 0 && "xl:border-l",
            i % 2 === 1 && "max-sm:border-l",
            i % 4 !== 0 && "sm:max-xl:border-l",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className={cx("label truncate", tone === "dark" ? "text-chalk/50" : "text-ink/50")}>{d.label}</span>
            <Prov p={d.prov} />
          </div>
          <div className={cx("num truncate text-[22px] font-medium md:text-[26px]", d.accent && "text-signal")}>
            {d.value == null ? (
              <span title={d.prov === "live" ? "No data yet" : "Pending real pricing benchmarks"} className="opacity-50">
                {d.placeholder}
              </span>
            ) : (
              <Counter value={d.value} format={d.format} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Count of real nodes this server has online. The only node count that may carry LIVE. */
export function LiveNodeCount({ className }: { className?: string }) {
  const n = useNetwork((s) => s.metrics.liveNodes);
  return <Counter value={n} format={fmtInt} className={className} />;
}

export function GpuCounter({ className }: { className?: string }) {
  const n = useNetwork((s) => s.metrics.gpusOnline);
  return <Counter value={n} format={fmtInt} className={className} />;
}
