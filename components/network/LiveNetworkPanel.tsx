"use client";

import { Dot, Prov } from "@/components/ui";
import { useNetwork } from "@/network/realtime/store";
import { useSim } from "@/network/realtime/mode";
import { cx, fmtInt } from "@/lib/format";
import { EventFeed } from "./EventFeed";
import { MetricsStrip } from "./Metrics";
import { CELL_RATIO, TopologyCanvas } from "./TopologyCanvas";

export function LiveNetworkPanel({ className, metrics = true, height = "h-[440px] md:h-[540px]" }: { className?: string; metrics?: boolean; height?: string }) {
  const live = useNetwork((s) => s.metrics.liveNodes);
  const rps = useNetwork((s) => s.metrics.requestsPerSec);
  const sim = useSim();
  return (
    <div data-theme="dark" className={cx("overflow-hidden rounded-[22px] bg-[#0f0f0e] text-chalk shadow-[0_40px_90px_-40px_rgba(17,17,16,0.55)] ring-1 ring-black/40", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-chalk/[0.08] px-4 py-3 md:px-5">
        <div className="flex items-center gap-3">
          <Dot />
          <span className="label text-chalk/80">Live topology</span>
          <span className="label hidden text-chalk/35 sm:inline">{sim ? `1 cell ≈ ${CELL_RATIO} nodes · sampled` : "device-class map · real nodes marked"}</span>
        </div>
        <div className="flex items-center gap-4 font-mono text-[11px] text-chalk/55">
          <span className="hidden items-center gap-1.5 md:flex">
            <span className="size-[6px] bg-signal" /> computing
          </span>
          <span className="hidden items-center gap-1.5 md:flex">
            <span className="size-[6px] bg-ok" /> real node
          </span>
          {sim && <span className="num">{fmtInt(rps)} req/s</span>}
          <span className="flex items-center gap-1.5">
            <span className={cx("num", live > 0 && "text-ok")}>{live}</span> live
            <Prov p={live > 0 || !sim ? "live" : "simulated"} />
          </span>
        </div>
      </div>
      <div className="grid lg:grid-cols-[1fr_300px]">
        <TopologyCanvas className={height} />
        <div className="relative hidden border-l border-chalk/[0.08] lg:block">
          <div className="flex items-center justify-between px-5 pt-4">
            <span className="label text-chalk/50">Event stream</span>
            <span className="font-mono text-[10px] text-chalk/30">{sim ? "SIM + LIVE" : "LIVE"}</span>
          </div>
          <div className="absolute inset-x-5 bottom-0 top-11 overflow-hidden [mask-image:linear-gradient(to_bottom,#000_70%,transparent)]">
            <EventFeed limit={18} />
          </div>
        </div>
      </div>
      <div className="border-t border-chalk/[0.08] px-4 py-3 lg:hidden">
        <div className="h-[150px] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_60%,transparent)]">
          <EventFeed limit={5} />
        </div>
      </div>
      {metrics && <MetricsStrip className="border-t border-chalk/[0.08] xl:border-t" />}
    </div>
  );
}
