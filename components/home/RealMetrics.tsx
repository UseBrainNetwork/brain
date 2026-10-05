"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ProviderHealth } from "@/domain/economy";
import { cx, fmtInt } from "@/lib/format";

/**
 * Homepage numbers that are REAL or absent. Reads /api/stats (server records) and /api/capacity
 * (provider health). Nothing here comes from the simulated demo feed, and nothing is estimated.
 */
interface Stats {
  nodesOnline: number;
  jobsCompleted: number;
  workUnitsVerified: number;
  verifiedComputeUnits: number;
  successRate: number | null;
}

export function RealMetricsStrip({ tone = "light", className }: { tone?: "light" | "dark"; className?: string }) {
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/stats", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => alive && setS(j))
        .catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const dark = tone === "dark";
  const cells: [string, string, boolean][] = [
    ["Nodes online", s ? fmtInt(s.nodesOnline) : "—", Boolean(s && s.nodesOnline > 0)],
    ["Jobs completed", s ? fmtInt(s.jobsCompleted) : "—", false],
    ["Verified work units", s ? fmtInt(s.workUnitsVerified) : "—", false],
    ["Compute units verified", s ? fmtInt(s.verifiedComputeUnits) : "—", false],
    ["Success rate", s ? (s.successRate == null ? "NOT ENOUGH DATA" : `${(s.successRate * 100).toFixed(1)}%`) : "—", false],
  ];
  return (
    <div className={cx("grid grid-cols-2 gap-px overflow-hidden rounded-[14px] sm:grid-cols-3 lg:grid-cols-5", dark ? "bg-chalk/10" : "bg-ink/10", className)}>
      {cells.map(([k, v, ok]) => (
        <div key={k} className={cx("px-4 py-3.5", dark ? "bg-ink-2" : "bg-paper")}>
          <div className={cx("font-mono text-[9.5px] uppercase tracking-[0.14em]", dark ? "text-chalk/45" : "text-fog")}>{k}</div>
          <div className={cx("num mt-1 text-[20px] leading-none", v === "NOT ENOUGH DATA" ? "text-[10px] uppercase tracking-[0.08em] opacity-50" : "", ok ? "text-ok" : dark ? "text-chalk" : "text-ink")}>{v}</div>
        </div>
      ))}
      <div className={cx("col-span-2 flex items-center justify-between px-4 py-3.5 font-mono text-[10.5px] sm:col-span-3 lg:col-span-5", dark ? "bg-ink-2 text-chalk/45" : "bg-paper text-fog")}>
        <span className="flex items-center gap-2">
          <span className="inline-block size-[6px] bg-ok" /> REAL · this server&apos;s records · refreshes every 15s
        </span>
        <Link href="/network" className={cx("hover:underline", dark ? "text-chalk/70" : "text-ink/70")}>
          Operations →
        </Link>
      </div>
    </div>
  );
}

const CLASSES: { target: ProviderHealth["target"]; label: string; what: string }[] = [
  { target: "BROWSER_NETWORK", label: "Browser compute", what: "Verified parallel matmul on contributors' GPUs" },
  { target: "NATIVE_NETWORK", label: "Native GPU", what: "Community machines running a native worker" },
  { target: "CLOUD_GPU", label: "Cloud GPU", what: "Operator-controlled inference" },
  { target: "EXTERNAL_MODEL", label: "External model", what: "Third-party model API" },
];

/** Four resource classes, each in its real state. Unconnected classes say so instead of pretending. */
export function ResourceClasses({ className }: { className?: string }) {
  const [health, setHealth] = useState<ProviderHealth[] | null>(null);
  const [nodes, setNodes] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/capacity", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        setHealth(j.providers ?? []);
        setNodes(typeof j.nodes === "number" ? j.nodes : null);
      })
      .catch(() => setHealth([]));
  }, []);
  return (
    <div className={cx("grid gap-px overflow-hidden rounded-[14px] bg-chalk/10 sm:grid-cols-2 lg:grid-cols-4", className)}>
      {CLASSES.map((c) => {
        const h = health?.find((x) => x.target === c.target);
        const status = h?.status ?? (health ? "UNCONFIGURED" : null);
        const live = status === "UP" || status === "DEGRADED";
        const label = status == null ? "…" : status === "UNCONFIGURED" ? (c.target === "NATIVE_NETWORK" ? "NOT CONNECTED" : "NOT CONFIGURED") : status === "DOWN" ? (c.target === "BROWSER_NETWORK" ? "NO NODES ONLINE" : "DOWN") : status;
        return (
          <div key={c.target} className="bg-ink-2 px-4 py-4">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-chalk/70">{c.label}</span>
              <span className={cx("inline-block size-[6px]", live ? "bg-ok" : "bg-chalk/25")} />
            </div>
            <div className={cx("mt-2 font-mono text-[12px]", live ? "text-ok" : "text-chalk/40")}>
              {label}
              {c.target === "BROWSER_NETWORK" && live && nodes != null ? ` · ${nodes} node${nodes === 1 ? "" : "s"}` : ""}
            </div>
            <div className="mt-1.5 text-[12px] leading-snug text-chalk/45">{c.what}</div>
          </div>
        );
      })}
    </div>
  );
}
