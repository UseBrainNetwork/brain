"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ComputeJob, JobStatus } from "@/domain/types";
import { Dot, Prov } from "@/components/ui";
import { useNetwork } from "@/network/realtime/store";
import { deviceLabel } from "@/services/mock/mockData";
import { getTopContributors } from "@/services/data";
import { cx, fmtCompact, fmtInt, fmtMs, fmtUsd } from "@/lib/format";

/** The stage a job is in at `now`, from its lifecycle timestamps. */
export function stageAt(j: ComputeJob, now: number): JobStatus {
  let s: JobStatus = "submitted";
  for (const e of j.lifecycle) if (e.at <= now) s = e.stage;
  return s;
}

export function useNow(ms = 250) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function StatusPill({ s }: { s: JobStatus }) {
  const done = s === "completed";
  const failed = s === "failed";
  return (
    <span className={cx("inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase", done ? "text-ok" : failed ? "text-signal" : "text-warn")}>
      <Dot color={done ? "ok" : failed ? "signal" : "warn"} pulse={!done && !failed} className="size-[6px]" />
      {done ? "verified" : s}
    </span>
  );
}

export function JobSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const id = q.trim().replace(/^#/, "");
        if (!/^\d{1,9}$/.test(id)) return setErr("Enter a numeric job id, e.g. 918240");
        router.push(`/explorer/job/${id}`);
      }}
      className="w-full max-w-[460px]"
    >
      <div className="flex h-12 items-center gap-3 rounded-full bg-paper px-5 shadow-[inset_0_0_0_1px_rgba(17,17,16,0.12)] focus-within:shadow-[inset_0_0_0_1px_rgba(17,17,16,0.5)]">
        <span className="font-mono text-[12px] text-fog">JOB #</span>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setErr(null);
          }}
          inputMode="numeric"
          placeholder="Look up a job id"
          aria-label="Job id"
          className="h-full min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-fog"
        />
        <button type="submit" className="font-mono text-[12px] font-semibold">
          OPEN →
        </button>
      </div>
      {err && <div className="mt-2 pl-5 font-mono text-[11px] text-signal">{err}</div>}
    </form>
  );
}

export function LiveJobsTable({ limit = 18 }: { limit?: number }) {
  const jobs = useNetwork((s) => s.jobs);
  const now = useNow();
  const rows = jobs.slice(0, limit);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] font-mono text-[12.5px]">
        <thead>
          <tr className="border-b border-ink/15 text-left text-[11px] uppercase tracking-[0.06em] text-fog">
            {["Job", "Model", "Nodes", "Compute", "Latency", "Status", "Age"].map((h, i) => (
              <th key={h} className={cx("py-3 font-medium", i >= 2 && i !== 5 && "text-right", i === 5 && "pl-8")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((j) => {
            const s = stageAt(j, now);
            const done = s === "completed" || s === "failed";
            return (
              <tr key={j.id} className="group border-b border-ink/[0.07] transition-colors hover:bg-ink/[0.03]">
                <td className="py-[11px]">
                  <Link href={`/explorer/job/${j.id}`} className="flex items-center gap-2 font-semibold group-hover:underline">
                    #{j.id} {j.provenance === "live" && <Prov p="live" />}
                  </Link>
                </td>
                <td className="text-ink/70">{j.model}</td>
                <td className="text-right">{j.nodeIds.length}</td>
                <td className="text-right">{j.computeUnits}u</td>
                <td className="text-right">{done ? fmtMs(j.latencyMs ?? 0) : <span className="text-fog">—</span>}</td>
                <td className="pl-8">
                  <StatusPill s={s} />
                </td>
                <td className="text-right text-fog">{now ? `${Math.max(0, Math.round((now - j.submittedAt) / 1000))}s` : ""}</td>
              </tr>
            );
          })}
          {!rows.length && (
            <tr>
              <td colSpan={7} className="py-10 text-center text-fog">
                Connecting to network stream…
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function LiveNodesTable() {
  const live = useNetwork((s) => s.liveNodes);
  const you = useNetwork((s) => s.localNodeId);
  const nodes = Object.values(live).sort((a, b) => b.verifiedJobs - a.verifiedJobs);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] font-mono text-[12.5px]">
        <thead>
          <tr className="border-b border-chalk/15 text-left text-[11px] uppercase tracking-[0.06em] text-chalk/40">
            {["Node", "Device class", "Score", "Verified jobs", "Rejected", "Reputation", "Status"].map((h, i) => (
              <th key={h} className={cx("py-3 font-medium", i >= 2 && i <= 5 && "text-right", i === 6 && "pl-8")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.id} className="border-b border-chalk/[0.07]">
              <td className="py-[11px] font-semibold">
                {n.id} {n.id === you && <span className="ml-1 text-signal">YOU</span>}
              </td>
              <td className="text-chalk/70">{deviceLabel(n.deviceClass)}</td>
              <td className="text-right">{fmtInt(n.computeScore)}</td>
              <td className="text-right text-ok">{fmtInt(n.verifiedJobs)}</td>
              <td className="text-right">{fmtInt(n.failedJobs)}</td>
              <td className="text-right">{n.reputation.toFixed(2)}</td>
              <td className="pl-8 uppercase text-chalk/70">{n.status}</td>
            </tr>
          ))}
          {!nodes.length && (
            <tr>
              <td colSpan={7} className="py-10 text-center text-chalk/45">
                No real nodes connected to this server right now.{" "}
                <Link href="/contribute" className="text-chalk underline underline-offset-4">
                  Be the first →
                </Link>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const contributors = getTopContributors(20);

export function TopContributorsTable() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] font-mono text-[12.5px]">
        <thead>
          <tr className="border-b border-ink/15 text-left text-[11px] uppercase tracking-[0.06em] text-fog">
            {["#", "Node", "Device class", "Verified compute", "Uptime", "Jobs", "Reward"].map((h, i) => (
              <th key={h} className={cx("py-3 font-medium", i >= 3 && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {contributors.map((c, i) => (
            <tr key={c.nodeId + i} className="border-b border-ink/[0.07]">
              <td className="py-[11px] text-fog">{String(i + 1).padStart(2, "0")}</td>
              <td className="font-semibold">{c.nodeId}</td>
              <td className="text-ink/70">{deviceLabel(c.deviceClass)}</td>
              <td className="text-right">{fmtCompact(c.verifiedCompute)}u</td>
              <td className="text-right">{c.uptimePct.toFixed(2)}%</td>
              <td className="text-right">{fmtInt(c.jobs)}</td>
              <td className="text-right font-semibold">{fmtUsd(c.rewardUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExplorerStats() {
  const m = useNetwork((s) => s.metrics);
  const jobs = useNetwork((s) => s.jobs);
  const live = useNetwork((s) => s.liveNodes);
  const lat = jobs.filter((j) => j.latencyMs).slice(0, 40);
  const avg = lat.length ? lat.reduce((s, j) => s + (j.latencyMs ?? 0), 0) / lat.length : 0;
  const stats = [
    { k: "Inferences today", v: fmtCompact(m.inferencesToday), p: "simulated" as const },
    { k: "Requests / sec", v: fmtInt(m.requestsPerSec), p: "simulated" as const },
    { k: "Avg latency (recent)", v: avg ? fmtMs(avg) : "—", p: "simulated" as const },
    { k: "Real nodes on this server", v: fmtInt(Object.keys(live).length), p: "live" as const },
  ];
  return (
    <div className="grid grid-cols-2 border-y border-ink/12 lg:grid-cols-4">
      {stats.map((s, i) => (
        <div key={s.k} className={cx("py-5 pr-4", i > 0 && "lg:border-l lg:border-ink/12 lg:pl-6", i % 2 === 1 && "max-lg:border-l max-lg:border-ink/12 max-lg:pl-4", i >= 2 && "max-lg:border-t max-lg:border-ink/12")}>
          <div className="label flex items-center gap-2 text-fog">
            {s.k} <Prov p={s.p} />
          </div>
          <div className="num mt-2 text-[28px] font-medium md:text-[36px]">{s.v}</div>
        </div>
      ))}
    </div>
  );
}
