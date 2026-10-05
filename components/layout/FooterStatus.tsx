"use client";

import { Prov } from "@/components/ui";
import { useNetwork } from "@/network/realtime/store";
import { fmtCompact, fmtInt } from "@/lib/format";

export function FooterStatus() {
  const m = useNetwork((s) => s.metrics);
  return (
    <div className="mt-8 inline-flex items-center gap-3 rounded-full border border-chalk/10 bg-chalk/[0.03] px-4 py-2 font-mono text-[11.5px] text-chalk/60">
      <span className="inline-block size-[6px] bg-ok" />
      <span suppressHydrationWarning>
        {fmtInt(m.gpusOnline)} GPUs online<span className="hidden sm:inline"> · {fmtCompact(m.inferencesToday, 1)} inferences today</span>
      </span>
      <Prov p="simulated" />
    </div>
  );
}
