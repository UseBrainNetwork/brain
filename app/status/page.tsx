import type { Metadata } from "next";
import Link from "next/link";
import { Metric, NO_DATA, Panel, PageHead, Shell, SourceBadge, when } from "@/components/economy/parts";
import { cx, fmtInt } from "@/lib/format";
import { statusData } from "@/services/statusPage";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Status",
  description: "Is BRAIN up, and how well is it working: database, hourly settlement, inference latency, verification, and every incident so far. Measured by the network itself.",
};

const ms = (n: number | null | undefined) => (n == null ? NO_DATA : n >= 10_000 ? `${(n / 1000).toFixed(1)} s` : `${fmtInt(Math.round(n))} ms`);
const ratio = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : NO_DATA);

export default async function StatusPage() {
  const d = await statusData();
  const db = d.database;
  const dbOpen = db?.lanes ? db.lanes.filter((l) => l.coolingDownSec === 0).length : null;
  const dbTone = !db || !db.ok ? "bad" : dbOpen != null && db.lanes && dbOpen < db.lanes.length ? "warn" : "ok";
  const s = d.settlement;
  const settlementTone = !s ? "muted" : s.settled > 0 && s.onTime === s.settled ? "ok" : s.settled > 0 ? "warn" : "muted";
  const headline = !db?.ok ? "Degraded." : dbTone === "warn" ? "Up, on a spare lane." : "Up.";

  return (
    <Shell>
      <PageHead
        eyebrow={
          <>
            Network · Status <SourceBadge source="REAL" />
          </>
        }
        title={headline}
        right={
          <div className="font-mono text-[11px] text-chalk/45">
            measured {when(d.asOf)}
            {d.stale && <span className="ml-2 text-warn">· live data delayed</span>}
          </div>
        }
      >
        What the network measures about itself: a timed read on the database, whether every hourly settlement ran and how late, how fast native nodes answered, how much browser work verified, and every incident with its cause. Nothing here comes from an outside monitor and nothing is estimated when its source is down; a section that cannot be read says so.
      </PageHead>

      <div className="mt-10 grid gap-px overflow-hidden rounded-[18px] bg-chalk/10 md:grid-cols-4">
        <div className="bg-ink p-7">
          <Metric k="Database" v={!db ? "unreadable" : db.ok ? "answering" : "not answering"} tone={dbTone} sub={db?.pingMs != null ? <>read in {db.pingMs} ms</> : "no read completed"} />
        </div>
        <div className="bg-ink p-7">
          <Metric k="Pooler lanes open" v={dbOpen == null ? NO_DATA : `${dbOpen} / ${db?.lanes?.length ?? 0}`} tone={dbTone} sub={db?.lanes ? db.lanes.map((l) => `${l.name}${l.coolingDownSec ? ` (cooling ${l.coolingDownSec}s)` : ""}`).join(" · ") : "memory store"} />
        </div>
        <div className="bg-ink p-7">
          <Metric k="Hourly settlements on time" v={s ? `${s.onTime} / ${s.settled}` : NO_DATA} tone={settlementTone} sub={s?.lateMaxMin != null ? <>latest window of {s.window} · slowest settled {s.lateMaxMin} min after close</> : "no live epochs yet"} />
        </div>
        <div className="bg-ink p-7">
          <Metric k="Latest epoch" v={s?.latest ? s.latest.id.replace(/^E-/, "") : NO_DATA} sub={s?.latest ? <>{fmtInt(s.latest.participants)} wallets · settled {s.latest.settledAfterMin} min after close</> : undefined} />
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Native node inference" right={d.inference ? `last ${d.inference.window} jobs${d.inference.sinceMs ? ` · since ${new Date(d.inference.sinceMs).toISOString().slice(0, 16).replace("T", " ")}Z` : ""}` : "unavailable"}>
          {!d.inference ? (
            <div className="font-mono text-[12px] text-chalk/40">Could not read inference jobs.</div>
          ) : d.inference.models.length === 0 ? (
            <div className="font-mono text-[12px] text-chalk/40">No customer inference job in the window. Benchmarks and canaries are excluded; they are scheduling, not service.</div>
          ) : (
            <table className="w-full font-mono text-[12px]">
              <thead className="text-[10px] uppercase tracking-[0.12em] text-chalk/40">
                <tr className="text-left">
                  <th className="pb-2 font-normal">Model</th>
                  <th className="pb-2 text-right font-normal">Done</th>
                  <th className="pb-2 text-right font-normal">Failed</th>
                  <th className="pb-2 text-right font-normal">p50</th>
                  <th className="pb-2 text-right font-normal">p95</th>
                  <th className="pb-2 text-right font-normal">tok/s</th>
                </tr>
              </thead>
              <tbody className="text-chalk/80">
                {d.inference.models.map((m) => (
                  <tr key={m.model} className="border-t border-chalk/10">
                    <td className="py-2 pr-3 text-chalk">{m.model}</td>
                    <td className="py-2 text-right">{fmtInt(m.completed)}</td>
                    <td className={cx("py-2 text-right", m.failed ? "text-warn" : "")}>{fmtInt(m.failed)}</td>
                    <td className="py-2 text-right">{ms(m.p50Ms)}</td>
                    <td className="py-2 text-right">{ms(m.p95Ms)}</td>
                    <td className="py-2 text-right">{m.tokPerSec == null ? NO_DATA : m.tokPerSec.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-3 font-mono text-[10.5px] text-chalk/40">Wall time is request to completion on the coordinator&apos;s clock. Tokens per second uses node-reported token counts over coordinator-timed compute.</div>
        </Panel>

        <Panel title="Browser network" right={d.browser ? `last ${d.browser.window} distributed jobs` : "unavailable"}>
          {!d.browser ? (
            <div className="font-mono text-[12px] text-chalk/40">Could not read distributed jobs.</div>
          ) : (
            <div className="grid grid-cols-2 gap-6 md:grid-cols-3">
              <Metric k="Units verified" v={ratio(d.browser.unitsVerified, d.browser.unitsVerified + d.browser.unitsFailed)} sub={<>{fmtInt(d.browser.unitsVerified)} verified · {fmtInt(d.browser.unitsFailed)} failed</>} tone={d.browser.unitsFailed === 0 ? "ok" : undefined} />
              <Metric k="Job latency p50" v={ms(d.browser.latencyP50Ms)} sub={<>p95 {ms(d.browser.latencyP95Ms)}</>} />
              <Metric k="Units reassigned" v={fmtInt(d.browser.reassigned)} sub={d.browser.reassignMedianMs != null ? <>median {ms(d.browser.reassignMedianMs)} from loss to new node</> : "no reassignment in window"} />
            </div>
          )}
          <div className="mt-3 font-mono text-[10.5px] text-chalk/40">
            A unit on a node that stops answering is handed to another node; the time between the two assignments is what &quot;reassigned&quot; measures. Detail per job on <Link href="/explorer" className="text-chalk underline decoration-chalk/25 underline-offset-4">/explorer</Link>.
          </div>
        </Panel>
      </div>

      <Panel className="mt-6" title="Incidents" right={`${d.incidents.length} recorded · UTC`}>
        {d.incidents.length === 0 ? (
          <div className="font-mono text-[12px] text-chalk/40">None recorded.</div>
        ) : (
          <ol className="divide-y divide-chalk/10">
            {d.incidents.map((i) => (
              <li key={`${i.date}-${i.title}`} className="grid gap-2 py-4 md:grid-cols-[140px_1fr]">
                <div className="font-mono text-[12px] text-chalk/50">{i.date}</div>
                <div>
                  <div className="text-[15px] text-chalk">{i.title}</div>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-chalk/60">{i.summary}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
        <div className="mt-4 font-mono text-[10.5px] text-chalk/40">
          Written by hand after each incident, with cause, cost and what changed. Full text in the{" "}
          <a href="https://docs.brainnetwork.app/trust/incident-log" className="text-chalk underline decoration-chalk/25 underline-offset-4">
            docs
          </a>
          . Machine-readable version of this page: <Link href="/api/status" className="text-chalk underline decoration-chalk/25 underline-offset-4">/api/status</Link>.
        </div>
      </Panel>
    </Shell>
  );
}
