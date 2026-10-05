"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ComputeOrder, Priority, RouteDecision, RoutingMode, ScoredEstimate } from "@/domain/economy";
import type { DistributedJob } from "@/domain/types";
import { cx } from "@/lib/format";
import { useReal } from "@/network/realtime/real";
import { UnitGrid } from "@/components/demo/UnitGrid";
import { Metric, Panel, SourceBadge, ms, usd } from "./parts";

type Phase = "idle" | "submitting" | "estimating" | "executing" | "done";

const TARGET_LABEL: Record<string, string> = { BROWSER_NETWORK: "Browser network", CLOUD_GPU: "Cloud GPU", EXTERNAL_PROVIDER: "External provider" };

export function AutoConsole() {
  const realNodes = useReal((r) => Object.keys(r.nodes).length);
  const liveJob = useReal((r) => r.jobs[0] ?? null);
  const [kind, setKind] = useState<"compute" | "chat">("compute");
  const [size, setSize] = useState<"small" | "medium" | "large">("medium");
  const [prompt, setPrompt] = useState("Explain in two sentences what a compute receipt is.");
  const [priority, setPriority] = useState<Priority>("CHEAP");
  const [mode, setMode] = useState<RoutingMode | "">("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [order, setOrder] = useState<ComputeOrder | null>(null);
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const startedAt = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (phase !== "submitting" && phase !== "estimating" && phase !== "executing") return;
    const t = setInterval(() => setElapsed(Date.now() - startedAt.current), 100);
    return () => clearInterval(t);
  }, [phase]);

  // Live job view while a compute order runs on the browser network.
  const runningJob: DistributedJob | null = phase === "executing" && kind === "compute" && liveJob && liveJob.createdAt >= startedAt.current - 500 ? liveJob : null;

  async function run() {
    setErr(null);
    setOrder(null);
    setDecision(null);
    setRevealed(0);
    startedAt.current = Date.now();
    setElapsed(0);
    setPhase("submitting");
    const request = kind === "compute" ? { kind: "compute", workload: "matmul_u32", size } : { kind: "chat", model: "brain/auto", messages: [{ role: "user", content: prompt }], maxTokens: 256 };
    // The server estimates, decides, executes and returns the terminal order. We show the stages
    // as they really happen: estimating is near-instant, execution is what takes time.
    const est = setTimeout(() => setPhase("estimating"), 150);
    const exec = setTimeout(() => setPhase("executing"), 700);
    try {
      const r = await fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request, priority, mode: mode || undefined }) });
      const j = await r.json();
      clearTimeout(est);
      clearTimeout(exec);
      if (!r.ok) {
        setErr(j.error === "invalid_request" ? "Invalid request." : String(j.error ?? "failed"));
        setPhase("idle");
        return;
      }
      const o: ComputeOrder = j.order;
      const d = o.decisionId ? ((await fetch(`/api/orders/${o.orderId}`).then((x) => x.json())) as { decision: RouteDecision | null }).decision : null;
      setDecision(d);
      setPhase("estimating");
      // Reveal the evaluated targets one by one, then the selection, then the result.
      const n = d?.estimates.length ?? 0;
      for (let i = 1; i <= n; i++) {
        await new Promise((res) => setTimeout(res, 260));
        setRevealed(i);
      }
      await new Promise((res) => setTimeout(res, 400));
      setOrder(o);
      setPhase("done");
    } catch {
      clearTimeout(est);
      clearTimeout(exec);
      setErr("Server unreachable.");
      setPhase("idle");
    }
  }

  const busy = phase !== "idle" && phase !== "done";

  return (
    <div className="mt-10 grid gap-6 lg:grid-cols-[380px_1fr]">
      {/* Request */}
      <Panel title="Request" right={<SourceBadge source="REAL" />}>
        <div className="flex gap-1 rounded-[8px] bg-ink-2 p-1 font-mono text-[11px] uppercase tracking-[0.1em]">
          {(["compute", "chat"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={cx("flex-1 rounded-[6px] py-2", kind === k ? "bg-chalk text-ink" : "text-chalk/60 hover:text-chalk")}>
              {k === "compute" ? "Verified compute" : "Chat (brain/auto)"}
            </button>
          ))}
        </div>
        {kind === "compute" ? (
          <div className="mt-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-chalk/45">Workload</div>
            <div className="mt-2 flex gap-1 font-mono text-[11px]">
              {(["small", "medium", "large"] as const).map((s) => (
                <button key={s} type="button" onClick={() => setSize(s)} className={cx("rounded px-3 py-1.5 uppercase tracking-[0.08em]", size === s ? "bg-chalk text-ink" : "text-chalk/60 ring-1 ring-inset ring-chalk/15")}>
                  {s}
                </button>
              ))}
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-chalk/50">Parallel u32 matrix multiplication split across every real node online ({realNodes} now), spot-check verified by the server. Not model inference.</p>
          </div>
        ) : (
          <div className="mt-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-chalk/45">Prompt</div>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value.slice(0, 2000))} rows={4} className="mt-2 w-full resize-none rounded-[8px] bg-ink-2 p-3 font-mono text-[12.5px] text-chalk outline-none ring-1 ring-inset ring-chalk/10 focus:ring-chalk/30" />
            <p className="mt-3 text-[12px] leading-relaxed text-chalk/50">Routed to a configured model provider. The browser network cannot run LLM inference yet, so it will be excluded with that reason shown.</p>
          </div>
        )}
        <div className="mt-5 font-mono text-[10px] uppercase tracking-[0.14em] text-chalk/45">Priority</div>
        <div className="mt-2 flex gap-1 font-mono text-[11px]">
          {(["CHEAP", "FAST", "BALANCED"] as const).map((p) => (
            <button key={p} type="button" onClick={() => setPriority(p)} className={cx("rounded px-3 py-1.5 tracking-[0.08em]", priority === p ? "bg-chalk text-ink" : "text-chalk/60 ring-1 ring-inset ring-chalk/15")}>
              {p}
            </button>
          ))}
        </div>
        <details className="mt-4 font-mono text-[11px] text-chalk/50">
          <summary className="cursor-pointer uppercase tracking-[0.12em] hover:text-chalk">Routing mode override</summary>
          <div className="mt-2 flex flex-wrap gap-1">
            {(["", "AUTO", "CHEAPEST", "FASTEST", "BROWSER_ONLY"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={cx("rounded px-2.5 py-1", mode === m ? "bg-chalk text-ink" : "text-chalk/60 ring-1 ring-inset ring-chalk/15")}>
                {m || "from priority"}
              </button>
            ))}
          </div>
        </details>
        <button type="button" disabled={busy || (kind === "compute" && realNodes === 0)} onClick={() => void run()} className="mt-6 h-12 w-full rounded-full bg-signal font-sans text-[14px] font-semibold text-white transition hover:bg-signal-2 disabled:opacity-40">
          {busy ? "Running…" : "Route & execute"}
        </button>
        {kind === "compute" && realNodes === 0 && <p className="mt-2 font-mono text-[11px] text-warn">No real nodes online. Open /node on a device and join first.</p>}
        {err && <p className="mt-2 font-mono text-[11px] text-signal">{err}</p>}
        <pre className="mt-5 overflow-x-auto rounded-[8px] bg-ink-2 p-3 font-mono text-[10.5px] leading-relaxed text-chalk/60">{`POST /v1/chat/completions
{ "model": "brain/auto",
  "priority": "${priority.toLowerCase()}",
  "messages": [...] }`}</pre>
      </Panel>

      {/* Route + result */}
      <div className="space-y-5">
        <Panel title="Route evaluation" right={<Stage phase={phase} elapsed={elapsed} />}>
          {!decision && phase === "idle" && <div className="font-mono text-[12px] text-chalk/40">Submit a request. Every execution target is estimated from measured latency and configured prices; unknown values are shown as UNKNOWN and penalised, never guessed.</div>}
          {!decision && busy && (
            <div className="space-y-2">
              {["BROWSER_NETWORK", "CLOUD_GPU", "EXTERNAL_PROVIDER"].map((t, i) => (
                <motion.div key={t} initial={{ opacity: 0.3 }} animate={{ opacity: [0.3, 0.7, 0.3] }} transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.15 }} className="h-12 rounded-[8px] bg-chalk/[0.04]" />
              ))}
            </div>
          )}
          {decision && (
            <div className="space-y-2">
              <AnimatePresence>
                {decision.estimates.slice(0, revealed).map((e) => (
                  <EstimateRow key={e.provider} e={e} selected={phase === "done" && decision.selected?.provider === e.provider} />
                ))}
              </AnimatePresence>
              {phase === "done" && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="pt-2 font-mono text-[11.5px] text-chalk/70">
                  {decision.reason}
                </motion.div>
              )}
            </div>
          )}
        </Panel>

        {runningJob && (
          <Panel title={`Executing on browser network · job #${runningJob.id}`} right={`${runningJob.totals.verified}/${runningJob.totals.workUnits} verified`}>
            <UnitGrid job={runningJob} />
          </Panel>
        )}

        <AnimatePresence>
          {phase === "done" && order && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
              <Panel title="Result" right={<span className={order.status === "COMPLETED" ? "text-ok" : "text-signal"}>{order.status}</span>}>
                {order.status === "COMPLETED" ? (
                  <>
                    {order.output && <div className="mb-5 whitespace-pre-wrap rounded-[8px] bg-ink-2 p-4 text-[14px] leading-relaxed text-chalk">{order.output}</div>}
                    <ResultMetrics order={order} />
                    <div className="mt-5 flex flex-wrap gap-4 font-mono text-[12px]">
                      {order.receiptId && (
                        <Link href={`/receipt/${order.receiptId}`} className="rounded-full bg-chalk px-4 py-2 font-sans font-semibold text-ink hover:bg-white">
                          View compute receipt →
                        </Link>
                      )}
                      {order.jobId && !order.jobId.startsWith("c-") && (
                        <Link href={`/explorer/job/${order.jobId}`} className="self-center text-chalk/60 hover:text-chalk">
                          Explorer →
                        </Link>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="font-mono text-[12.5px] text-chalk/70">
                    {order.error}
                    {order.receiptId && (
                      <div className="mt-3">
                        <Link href={`/receipt/${order.receiptId}`} className="text-chalk underline underline-offset-4">
                          Failure receipt →
                        </Link>
                      </div>
                    )}
                  </div>
                )}
              </Panel>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Stage({ phase, elapsed }: { phase: Phase; elapsed: number }) {
  const label = phase === "idle" ? "READY" : phase === "submitting" ? "REQUEST" : phase === "estimating" ? "ESTIMATING TARGETS" : phase === "executing" ? "EXECUTING" : "DONE";
  return (
    <span className={cx("flex items-center gap-2", phase === "done" ? "text-ok" : phase === "idle" ? "" : "text-signal")}>
      {label}
      {phase !== "idle" && <span className="text-chalk/40">{(elapsed / 1000).toFixed(1)}s</span>}
    </span>
  );
}

function EstimateRow({ e, selected }: { e: ScoredEstimate; selected: boolean }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0, backgroundColor: selected ? "rgba(84, 200, 120, 0.10)" : "rgba(255,255,255,0.03)" }}
      className={cx("grid grid-cols-[1fr_auto] gap-4 rounded-[8px] px-4 py-3 font-mono text-[12px]", !e.eligible && "opacity-50")}
    >
      <div>
        <div className="flex items-center gap-2 text-chalk">
          <span className={cx("inline-block size-[6px]", selected ? "bg-ok" : e.eligible ? "bg-chalk/40" : "bg-signal/60")} />
          {TARGET_LABEL[e.target] ?? e.target} <span className="text-chalk/40">· {e.provider}</span>
          {selected && <span className="ml-2 text-ok">SELECTED</span>}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-chalk/60">
          <span>cost {e.estimatedCost == null ? "UNKNOWN" : usd(e.estimatedCost)}</span>
          <span>latency {ms(e.estimatedLatency)}</span>
          <span>reliability {(e.reliability * 100).toFixed(0)}%</span>
          <span>capacity {(e.capacity * 100).toFixed(0)}%</span>
          <span>confidence {(e.confidence * 100).toFixed(0)}%</span>
        </div>
        {e.notes.length > 0 && <div className="mt-1 text-[11px] text-chalk/40">{e.notes.join(" · ")}</div>}
      </div>
      <div className="text-right">
        <div className="text-[10px] uppercase tracking-[0.12em] text-chalk/40">score</div>
        <div className={cx("num text-[18px]", e.eligible ? "text-chalk" : "text-chalk/30")}>{e.eligible ? e.score.toFixed(3) : "—"}</div>
      </div>
    </motion.div>
  );
}

function ResultMetrics({ order }: { order: ComputeOrder }) {
  const [r, setR] = useState<{ nodesUsed: string[]; verifiedWorkUnits: number; workUnits: number; totalComputeUnits: number; executionTimeMs: number; customerCost: { amount: number } | null; verificationMethod: string } | null>(null);
  useEffect(() => {
    if (!order.receiptId) return;
    fetch(`/api/receipts/${order.receiptId}`)
      .then((x) => x.json())
      .then((j) => setR(j.receipt))
      .catch(() => {});
  }, [order.receiptId]);
  if (!r) return null;
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-5">
      <Metric k="Nodes used" v={r.nodesUsed.length} />
      <Metric k="Verified units" v={`${r.verifiedWorkUnits} / ${r.workUnits}`} tone={r.verifiedWorkUnits === r.workUnits && r.workUnits > 0 ? "ok" : undefined} />
      <Metric k="Compute units" v={r.totalComputeUnits.toLocaleString("en-US")} />
      <Metric k="Execution" v={ms(r.executionTimeMs)} />
      <Metric k="Cost" v={r.customerCost ? usd(r.customerCost.amount) : "UNKNOWN"} sub={r.verificationMethod} />
    </div>
  );
}
