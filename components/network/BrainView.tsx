"use client";

import { Counter, Dot, Prov } from "@/components/ui";
import { useNetwork } from "@/network/realtime/store";
import { useSim } from "@/network/realtime/mode";
import { cx, fmtInt } from "@/lib/format";
import { EventFeed } from "./EventFeed";
import { JobWaterfall } from "./JobWaterfall";
import { ComputeDie } from "./ComputeDie";

export function BrainStats() {
  const m = useNetwork((s) => s.metrics);
  const sim = useSim();
  const capacity = sim ? m.capacityScore * (m.gpusOnline / 12_842) * (0.985 + (m.requestsPerSec % 7) / 250) : m.capacityScore;
  const stats = sim
    ? [
        { k: "Nodes", v: m.gpusOnline, f: fmtInt },
        { k: "Memory", v: m.availableMemoryTb, f: (n: number) => `${n.toFixed(1)} TB` },
        { k: "Current capacity", v: capacity, f: (n: number) => `${n.toFixed(1)}`, unit: "index" },
        { k: "Requests / sec", v: m.requestsPerSec, f: fmtInt },
      ]
    : [
        { k: "Real nodes", v: m.liveNodes, f: fmtInt },
        { k: "Memory", v: m.availableMemoryTb, f: (n: number) => `${n.toFixed(2)} TB` },
        { k: "Capacity score", v: capacity, f: fmtInt, unit: "sum" },
        { k: "Requests / sec", v: m.requestsPerSec, f: fmtInt },
      ];
  return (
    <div className="grid grid-cols-2 border-y border-chalk/10 lg:grid-cols-4">
      {stats.map((s, i) => (
        <div key={s.k} className={cx("py-6 pr-4 md:py-8", i > 0 && "lg:border-l lg:border-chalk/10 lg:pl-8", i % 2 === 1 && "max-lg:border-l max-lg:border-chalk/10 max-lg:pl-5", i >= 2 && "max-lg:border-t max-lg:border-chalk/10")}>
          <div className="label flex items-center gap-2 text-chalk/45">
            {s.k} <Prov p={sim ? "simulated" : "live"} />
          </div>
          <div className="num mt-3 whitespace-nowrap text-[30px] font-medium leading-none sm:text-[38px] md:text-[64px]">
            <Counter value={s.v} format={s.f} />
            {s.unit && <span className="ml-2 align-middle font-mono text-[12px] text-chalk/35">{s.unit}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ModelPools() {
  const pools = useNetwork((s) => s.pools);
  const sim = useSim();
  const total = pools.reduce((s, p) => s + p.requestsPerSec, 0);
  if (!sim)
    return (
      <div className="rounded-[20px] bg-ink-2 p-6 font-mono text-[12.5px] text-chalk/55 ring-1 ring-chalk/[0.06]">
        Model pools form once enough real nodes are online to serve a model. None yet. Pool projections are available under “Show simulated data” in the footer.
      </div>
    );
  return (
    <div className="grid gap-px overflow-hidden rounded-[20px] bg-chalk/10 sm:grid-cols-2 xl:grid-cols-4">
      {pools.map((p) => (
        <div key={p.id} className="bg-ink-2 p-6">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-chalk/40">{p.model}</span>
            <span className={cx("flex items-center gap-1.5 font-mono text-[11px] font-semibold", p.status === "online" ? "text-ok" : "text-warn")}>
              <Dot color={p.status === "online" ? "ok" : "warn"} /> {p.status.toUpperCase()}
            </span>
          </div>
          <div className="display-md mt-5 text-[26px]">{p.label}</div>
          <div className="num mt-6 text-[34px]">
            <Counter value={p.nodes} format={fmtInt} />
            <span className="ml-2 font-mono text-[12px] text-chalk/40">nodes</span>
          </div>
          <div className="mt-5 h-1 overflow-hidden rounded-full bg-chalk/10">
            <div className="h-full bg-signal" style={{ width: `${(p.requestsPerSec / total) * 100}%` }} />
          </div>
          <div className="mt-2 flex justify-between font-mono text-[11px] text-chalk/45">
            <span>{p.requestsPerSec} req/s</span>
            <span>≥ {p.minMemoryGb} GB / node</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function FeedTag() {
  const sim = useSim();
  return <span className="font-mono text-[10px] text-chalk/30">{sim ? "SIM + LIVE" : "LIVE"}</span>;
}

export function BrainLive() {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="overflow-hidden rounded-[22px] bg-[#0f0f0e] ring-1 ring-chalk/[0.06]">
        <ComputeDie className="h-[440px] md:h-[640px]" />
      </div>
      <div className="flex flex-col rounded-[22px] bg-ink-2 p-5 ring-1 ring-chalk/[0.06]">
        <div className="flex items-center justify-between">
          <span className="label text-chalk/50">Events</span>
          <FeedTag />
        </div>
        <div className="relative mt-2 min-h-[300px] flex-1 overflow-hidden [mask-image:linear-gradient(to_bottom,#000_75%,transparent)]">
          <div className="absolute inset-0">
            <EventFeed limit={24} />
          </div>
        </div>
      </div>
    </div>
  );
}

export { JobWaterfall };
