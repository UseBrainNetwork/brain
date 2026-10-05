"use client";

import { useEffect, useRef } from "react";
import { useNetwork } from "@/network/realtime/store";
import { getRevenue, getToken } from "@/services/data";
import { cx, fmtCompact, fmtInt, fmtUsd } from "@/lib/format";

const today = getRevenue().find((r) => r.period === "today")!;
const token = getToken();

interface Quote {
  k: string;
  v: number;
  f: (n: number) => string;
}

/** Tape of network quotes. Arrows compare against the previous store value, so they move with real drift. */
export function Ticker({ className }: { className?: string }) {
  const m = useNetwork((s) => s.metrics);
  const pools = useNetwork((s) => s.pools);
  const prev = useRef(new Map<string, number>());
  const quotes: Quote[] = [
    { k: "GPUS ONLINE", v: m.gpusOnline, f: fmtInt },
    { k: "MEMORY", v: m.availableMemoryTb, f: (n) => `${n.toFixed(1)} TB` },
    { k: "REQ/S", v: m.requestsPerSec, f: fmtInt },
    { k: "INFERENCES 24H", v: m.inferencesToday, f: fmtCompact },
    ...pools.map((p) => ({ k: p.label, v: p.nodes, f: (n: number) => `${fmtInt(n)} nodes` })),
    { k: "CREATOR REWARDS 24H", v: today.creatorRewardsUsd, f: fmtUsd },
    { k: "PAID TO GPUS 24H", v: today.computePayoutsUsd, f: fmtUsd },
    { k: "UPTIME", v: m.uptimePct, f: (n) => `${n.toFixed(2)}%` },
    { k: token.symbol, v: token.priceUsd, f: (n) => `$${n.toFixed(6)}` },
  ];
  const rows = quotes.map((q) => {
    const p = prev.current.get(q.k);
    const dir = p == null || p === q.v ? 0 : q.v > p ? 1 : -1;
    return { ...q, dir };
  });
  useEffect(() => {
    for (const q of quotes) prev.current.set(q.k, q.v);
  });

  const strip = (
    <div className="flex shrink-0 items-center">
      {rows.map((q) => (
        <span key={q.k} className="flex items-center gap-2.5 border-r border-chalk/10 px-6 font-mono text-[11.5px]">
          <span className="text-chalk/45">{q.k}</span>
          <span className="num text-chalk">{q.f(q.v)}</span>
          <span className={cx("w-2 text-[9px]", q.dir > 0 ? "text-ok" : q.dir < 0 ? "text-signal" : "text-chalk/25")}>{q.dir > 0 ? "▲" : q.dir < 0 ? "▼" : "■"}</span>
        </span>
      ))}
      <span className="px-6 font-mono text-[10px] text-chalk/30">SIM · DEMO DATA</span>
    </div>
  );
  return (
    <div data-theme="dark" className={cx("relative flex h-11 items-center overflow-hidden bg-ink text-chalk", className)}>
      <div className="ticker flex w-max" style={{ ["--ticker-dur" as string]: "70s" }}>
        {strip}
        {strip}
      </div>
    </div>
  );
}
