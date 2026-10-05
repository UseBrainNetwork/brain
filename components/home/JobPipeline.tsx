"use client";

import { motion, useMotionValueEvent, useScroll } from "motion/react";
import { useRef, useState } from "react";
import { Container } from "@/components/ui";
import { cx } from "@/lib/format";
import { TraceCanvas } from "./TraceCanvas";

const NODES = ["8A21", "19F2", "81CC", "28AA"];

/** One inference request through the system. Example trace; values are illustrative, labeled as such. */
const stages: { key: string; label: string; title: string; body: string; log: { t: string; line: string; tone?: "ok" | "signal" }[] }[] = [
  {
    key: "request",
    label: "Request",
    title: "A developer sends one request",
    body: "POST /v1/chat/completions with model brain/auto. Same shape as the OpenAI API, so existing SDKs work unchanged.",
    log: [{ t: "0.000", line: "POST /v1/chat/completions  model=brain/auto  priority=cheap" }],
  },
  {
    key: "gateway",
    label: "Gateway",
    title: "The gateway checks and meters it",
    body: "API key, rate limit, schema validation, and a usage meter that every later step reports into.",
    log: [{ t: "0.004", line: "auth ok  customer=c_31f9  rate=18/60  schema ok  usage meter armed" }],
  },
  {
    key: "router",
    label: "Router",
    title: "The router picks an execution path",
    body: "Browser network, cloud fallback, or an external model provider, ranked by model compatibility, live capacity, latency, cost and reliability.",
    log: [
      { t: "0.011", line: "estimate  BROWSER_NETWORK  cost 0.0021  p50 1.8s  capacity 4  score 0.21", tone: "signal" },
      { t: "0.011", line: "estimate  CLOUD_GPU        cost 0.0090  p50 0.9s  capacity ∞  score 0.47" },
      { t: "0.012", line: "estimate  EXTERNAL         cost 0.0150  p50 1.1s  capacity ∞  score 0.63" },
      { t: "0.012", line: "route → BROWSER_NETWORK (CHEAPEST)", tone: "signal" },
    ],
  },
  {
    key: "split",
    label: "Split",
    title: "Work splits into units",
    body: "Each unit is sized to a node's server-verified score and the memory its adapter can actually allocate. Nothing the browser claims is taken on trust.",
    log: [{ t: "0.015", line: "job #918282  split → 4 units  secret rows chosen" }],
  },
  {
    key: "nodes",
    label: "Nodes",
    title: "Browsers execute on their GPUs",
    body: "WGSL compute kernels run through WebGPU on four ordinary machines: two laptops, a gaming PC and a workstation.",
    log: NODES.map((n, i) => ({ t: (0.02 + i * 0.003).toFixed(3), line: `unit ${String.fromCharCode(65 + i)} → node ${n}  assigned  computing` })),
  },
  {
    key: "verify",
    label: "Verify",
    title: "The server checks the work",
    body: "Rows chosen in secret before dispatch are recomputed server-side. Canary jobs have known answers. Low-reputation nodes get redundant replicas.",
    log: NODES.map((n, i) => ({ t: (1.21 + i * 0.09).toFixed(3), line: `unit ${String.fromCharCode(65 + i)} ← node ${n}  spot-check 8/8 rows  VERIFIED`, tone: "ok" as const })),
  },
  {
    key: "merge",
    label: "Merge",
    title: "Verified pieces merge",
    body: "Unit results are reassembled in order. A unit that fails verification is re-dispatched; the bad node loses reputation.",
    log: [{ t: "1.602", line: "merge 4/4 in order  result hash 9f3c…e1a0" }],
  },
  {
    key: "response",
    label: "Response",
    title: "The answer comes back. Contributors get credit.",
    body: "Verified compute units are credited to each node and settle against the reward pool at the end of the epoch.",
    log: [
      { t: "1.794", line: "200 OK  receipt r-918282  latency 1.79s", tone: "ok" },
      { t: "1.794", line: `credit  ${NODES.map((n) => `${n} +8u`).join("  ")}`, tone: "ok" },
    ],
  },
];

export function JobPipeline() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const [p, setP] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (v) => setP(v));
  const n = stages.length;
  const s = Math.min(n - 0.001, Math.max(0, ((p - 0.04) / 0.88) * n));
  const active = Math.floor(s);
  const lines = stages.slice(0, active + 1).flatMap((s) => s.log.map((l) => ({ ...l, stage: s.key })));

  return (
    <section ref={ref} data-theme="dark" className="surface-dark relative h-[420vh]">
      <div className="sticky top-0 flex h-dvh flex-col overflow-hidden">
        <Container className="flex flex-1 flex-col pt-20 md:pt-28">
          <div className="flex flex-col justify-between gap-4 border-b border-chalk/10 pb-6 md:flex-row md:items-end">
            <h2 className="display text-[34px] md:text-[56px]">One request, traced.</h2>
            <p className="hidden max-w-[380px] text-[15px] leading-relaxed text-chalk/60 md:block">
              From API call to paid contributors. Scroll to step through it.
              <span className="ml-2 font-mono text-[11px] uppercase tracking-[0.08em] text-chalk/35">example trace</span>
            </p>
          </div>

          <div className="grid flex-1 gap-8 pb-8 pt-6 md:grid-cols-[220px_1fr] md:pb-10 xl:grid-cols-[220px_1fr_400px]">
            {/* Steps */}
            <ol className="hidden flex-col md:flex md:border-r md:border-chalk/10 md:pr-6">
              {stages.map((s, i) => {
                const reached = i <= active;
                const current = i === active;
                return (
                  <li key={s.key} className={cx("grid grid-cols-[28px_1fr] items-baseline gap-3 py-2 transition-colors duration-300", current ? "text-chalk" : reached ? "text-chalk/55" : "text-chalk/25")}>
                    <span className={cx("num text-[11px]", current ? "text-signal" : "")}>{String(i + 1).padStart(2, "0")}</span>
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-mono text-[12px] uppercase tracking-[0.08em]">{s.label}</span>
                      {reached && <span className={cx("inline-block size-[6px]", current ? "bg-signal" : "bg-ok")} />}
                    </span>
                  </li>
                );
              })}
              <li className="hidden pt-8 md:block">
                <motion.h3 key={stages[active].key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="display-md text-[22px] text-chalk">
                  {stages[active].title}
                </motion.h3>
                <motion.p key={`${stages[active].key}-b`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35, delay: 0.05 }} className="mt-2 text-[13px] leading-relaxed text-chalk/60">
                  {stages[active].body}
                </motion.p>
              </li>
            </ol>

            {/* Trace scene */}
            <div className="flex min-h-0 flex-col">
              <div className="relative min-h-[380px] flex-1">
                <TraceCanvas s={s} nodes={NODES} />
              </div>
              <div className="mt-4 min-h-[88px] md:hidden">
                <h3 className="display-md text-[18px] text-chalk">{stages[active].title}</h3>
                <p className="mt-1 line-clamp-3 text-[12.5px] leading-relaxed text-chalk/60">{stages[active].body}</p>
              </div>
            </div>

            {/* Trace log */}
            <div className="hidden min-h-0 flex-col xl:flex">
              <div className="flex items-center justify-between border-b border-chalk/10 pb-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-chalk/40">
                <span>trace · job #918282</span>
                <span>
                  {lines.length} events · {stages[active].label}
                </span>
              </div>
              <ol className="mt-2 flex-1 overflow-hidden font-mono text-[12px] leading-[1.9] md:text-[12.5px]">
                {lines.map((l, i) => (
                  <motion.li key={`${l.stage}-${i}`} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25, delay: Math.min(0.3, (i - (lines.length - stages[active].log.length)) * 0.06) }} className="grid grid-cols-[52px_1fr] gap-4 border-b border-chalk/[0.06]">
                    <span className="num text-chalk/35">{l.t}s</span>
                    <span className={cx("truncate", l.tone === "ok" ? "text-ok" : l.tone === "signal" ? "text-signal-2" : "text-chalk/80")}>{l.line}</span>
                  </motion.li>
                ))}
                {active < n - 1 && (
                  <li className="grid grid-cols-[52px_1fr] gap-4">
                    <span />
                    <span className="text-chalk/30">
                      <span className="animate-blink">▍</span>
                    </span>
                  </li>
                )}
              </ol>
            </div>
          </div>
        </Container>
      </div>
    </section>
  );
}
