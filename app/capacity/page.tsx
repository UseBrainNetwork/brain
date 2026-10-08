import type { Metadata } from "next";
import Link from "next/link";
import { Metric, Panel, PageHead, Shell, SourceBadge, pct } from "@/components/economy/parts";
import type { CapabilityState } from "@/domain/economy";
import { executionProviders } from "@/engine/providers";
import { cx, fmtInt } from "@/lib/format";
import { assessCapabilities } from "@/services/capability";
import { isStoreUnavailable, isTransientDbError } from "@/services/failsoft";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Capacity", description: "What the BRAIN network can execute right now, derived from real nodes and real jobs." };

const STATE: Record<CapabilityState, string> = { AVAILABLE: "text-ok", LIMITED: "text-warn", UNAVAILABLE: "text-signal", EXPERIMENTAL: "text-chalk/40" };

export default async function CapacityPage() {
  let caps: Awaited<ReturnType<typeof assessCapabilities>>;
  let health: Awaited<ReturnType<ReturnType<typeof executionProviders>[number]["health"]>>[];
  try {
    [caps, health] = await Promise.all([assessCapabilities(), Promise.all(executionProviders().map((p) => p.health()))]);
  } catch (e) {
    // Capacity is derived from the nodes and jobs in the database. If the database is not answering,
    // say so; do not show a capacity that was not read.
    if (!isTransientDbError(e)) throw e;
    const retryAfterSec = isStoreUnavailable(e) ? e.retryAfterSec : 15;
    return (
      <Shell>
        <PageHead
          eyebrow={
            <>
              Network capacity <SourceBadge source="REAL" />
            </>
          }
          title="The database is not answering right now."
        >
          Capacity is derived from the real nodes and jobs in the server&apos;s store, which cannot be read at the moment. Nothing is shown that was not read; retry in {retryAfterSec} seconds.
        </PageHead>
        <Link href="/capacity" className="mt-6 inline-block font-mono text-[12px] text-chalk underline underline-offset-4">
          Retry →
        </Link>
      </Shell>
    );
  }
  const reached = caps.levels.filter((l) => l.reached).length;
  return (
    <Shell>
      <PageHead
        eyebrow={
          <>
            Network capacity <SourceBadge source="REAL" />
          </>
        }
        title="What the network can do right now."
        right={
          <Link href="/demo" className="font-mono text-[11px] uppercase tracking-[0.12em] text-chalk/60 hover:text-chalk">
            Live network →
          </Link>
        }
      >
        Every state below is computed from the nodes connected to this server and the jobs they have completed. A capability is AVAILABLE only once the network has actually demonstrated it.
      </PageHead>

      <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-7 md:grid-cols-4">
        <Metric k="Real nodes online" v={caps.nodes} big />
        <Metric k="Aggregate capacity" v={fmtInt(caps.capacityScore)} big sub="sum of verified scores" />
        <Metric k="Capabilities available" v={`${caps.capabilities.filter((c) => c.state === "AVAILABLE").length} / ${caps.capabilities.filter((c) => c.state !== "EXPERIMENTAL").length}`} />
        <Metric k="Network level" v={`${reached} / ${caps.levels.length}`} sub={caps.levels[reached]?.label ? `next: ${caps.levels[reached].label}` : "all levels reached"} />
      </div>

      <div className="mt-10 grid gap-4 lg:grid-cols-2">
        {caps.capabilities.map((c) => (
          <Panel key={c.id} title={c.label} right={<span className={cx("font-semibold", STATE[c.state])}>{c.state}</span>}>
            <p className="text-[13px] text-chalk/60">{c.description}</p>
            <ul className="mt-3 space-y-1 font-mono text-[11.5px]">
              {c.requirements.map((r) => (
                <li key={r.label} className="flex items-center justify-between gap-4 border-b border-chalk/[0.07] py-1">
                  <span className="text-chalk/55">{r.label}</span>
                  <span className={r.met ? "text-ok" : "text-chalk/45"}>
                    {r.current} <span className="text-chalk/35">/ {r.required}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-3 font-mono text-[11px] text-chalk/45">
              {c.reasons.join(" · ")} · success {pct(c.evidence.recentSuccessRate, 0)} over {c.evidence.recentJobs} job{c.evidence.recentJobs === 1 ? "" : "s"}
            </div>
          </Panel>
        ))}
      </div>

      <Panel className="mt-10" title="Network capability progression" right="from actual capacity only">
        <div className="grid gap-3 md:grid-cols-5">
          {caps.levels.map((l) => (
            <div key={l.level} className={cx("rounded-[10px] border p-4", l.reached ? "border-ok/40 bg-ok/[0.06]" : "border-chalk/10")}>
              <div className="flex items-baseline justify-between font-mono text-[11px]">
                <span className={l.reached ? "text-ok" : "text-chalk/45"}>LEVEL {l.level}</span>
                <span className={l.reached ? "text-ok" : "text-chalk/35"}>{l.reached ? "REACHED" : "LOCKED"}</span>
              </div>
              <div className="mt-2 text-[14px] text-chalk">{l.label}</div>
              <ul className="mt-3 space-y-1 font-mono text-[10.5px]">
                {l.requirements.map((r) => (
                  <li key={r.label} className="flex justify-between gap-2">
                    <span className="text-chalk/50">{r.label}</span>
                    <span className={r.met ? "text-ok" : "text-chalk/45"}>
                      {r.current}/{r.required}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Panel>

      <Panel className="mt-5" title="Execution targets" right="health">
        <div className="grid gap-2 font-mono text-[12px] md:grid-cols-3">
          {health.map((h) => (
            <div key={h.provider} className="rounded-[8px] bg-ink-2 p-3">
              <div className="flex justify-between">
                <span className="text-chalk">{h.provider}</span>
                <span className={h.status === "UP" ? "text-ok" : h.status === "DEGRADED" ? "text-warn" : h.status === "DOWN" ? "text-signal" : "text-chalk/40"}>{h.status}</span>
              </div>
              <div className="mt-1 text-chalk/45">{h.target}</div>
              <div className="mt-1 text-chalk/60">{h.detail}</div>
            </div>
          ))}
        </div>
      </Panel>
    </Shell>
  );
}
