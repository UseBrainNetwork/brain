"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { Prov } from "@/components/ui";
import { useSim } from "@/network/realtime/mode";
import type { ContributorState } from "@/network/client/contributor";
import { cx, fmtBytes, fmtInt } from "@/lib/format";
import type { DetectedField, DeviceDetection, FieldSource } from "@/webgpu/detect";

export function StepShell({
  n,
  title,
  state,
  open,
  children,
  aside,
}: {
  n: string;
  title: string;
  state: "locked" | "current" | "done";
  open: boolean;
  children?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div
      className={cx(
        "rounded-[20px] transition-[background,box-shadow,opacity] duration-300",
        open ? "bg-paper shadow-[0_1px_0_rgba(255,255,255,0.8)_inset,0_20px_50px_-30px_rgba(17,17,16,0.35)]" : "bg-bone-2/60",
        state === "locked" && "opacity-55",
      )}
    >
      <div className="flex items-center justify-between px-5 py-4 md:px-6">
        <div className="flex items-center gap-3">
          <span
            className={cx(
              "grid size-6 place-items-center rounded-full font-mono text-[10px] font-semibold",
              state === "done" ? "bg-ink text-chalk" : state === "current" ? "bg-signal text-white" : "bg-ink/10 text-ink/50",
            )}
          >
            {state === "done" ? "✓" : n}
          </span>
          <span className="text-[15px] font-semibold tracking-[-0.01em]">{title}</span>
        </div>
        {aside}
      </div>
      <AnimatePresence initial={false}>
        {children && open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.35, ease: [0.3, 0.7, 0.2, 1] }} className="overflow-hidden">
            <div className="px-5 pb-6 md:px-6">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const sourceStyle: Record<FieldSource, string> = {
  webgpu: "text-ok",
  webgl: "text-ok",
  navigator: "text-ink/50",
  inferred: "text-warn",
  unavailable: "text-ink/35",
};

function Field<T>({ k, f, fmt }: { k: string; f: DetectedField<T>; fmt?: (v: T) => string }) {
  return (
    <div className="grid grid-cols-[120px_1fr_auto] items-baseline gap-3 border-b border-ink/10 py-2.5 font-mono text-[12px] max-sm:grid-cols-[100px_1fr]">
      <span className="text-ink/50">{k}</span>
      <span className={cx("truncate", f.value == null && "text-ink/40")} title={f.note}>
        {f.value == null ? (f.note ?? "unavailable") : fmt ? fmt(f.value) : String(f.value)}
      </span>
      <span className={cx("text-[10px] uppercase tracking-[0.08em] max-sm:hidden", sourceStyle[f.source])}>{f.source}</span>
    </div>
  );
}

export function DeviceReport({ d }: { d: DeviceDetection }) {
  const ready = d.webgpu === "ready";
  return (
    <div>
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <div className={cx("label", ready ? "text-ok" : "text-signal")}>{ready ? "Device detected" : "WebGPU unavailable"}</div>
          <div className="display-md mt-2 text-[26px] md:text-[30px]">{d.gpuName.value ?? (ready ? "WebGPU adapter" : "Unknown GPU")}</div>
        </div>
        <span className={cx("rounded-full px-2.5 py-1 font-mono text-[11px] font-semibold", ready ? "bg-ok/15 text-ok" : "bg-signal/10 text-signal")}>
          WEBGPU: {ready ? "READY" : d.webgpu === "no-adapter" ? "NO ADAPTER" : d.webgpu === "error" ? "ERROR" : "UNSUPPORTED"}
        </span>
      </div>
      <div className="border-t border-ink/10">
        <Field k="GPU memory" f={d.gpuMemory} />
        <Field k="Max buffer" f={d.maxBufferBytes} fmt={(v) => `${fmtBytes(v)} (adapter limit)`} />
        <Field k="Vendor" f={d.vendor} />
        <Field k="Architecture" f={d.architecture} />
        <Field k="System memory" f={d.systemMemoryGb} fmt={(v) => `≥ ${v} GB`} />
        <Field k="CPU threads" f={d.cpuThreads} />
        <Field k="Browser" f={d.browser} />
        <Field k="OS" f={d.os} />
      </div>
      {d.isFallbackAdapter && <p className="mt-3 font-mono text-[11px] text-warn">Software fallback adapter: compute will be slow and may not qualify.</p>}
      {!ready && (
        <div className="mt-5 rounded-xl bg-bone-2 p-4 text-[13.5px] leading-relaxed text-ink/70">
          {d.error ? <div className="mb-2 font-mono text-[11px] text-signal">{d.error}</div> : null}
          {d.webgpu === "unsupported" ? "This browser doesn't expose WebGPU" : "WebGPU is present but no GPU adapter was granted"}, so this device can&apos;t contribute yet. Chrome or Edge 113+, Safari 26+, or Firefox 141+ on Windows support it. On Linux
          Chrome, enable <code className="font-mono text-[12px]">chrome://flags/#enable-unsafe-webgpu</code>. You can still use the network and watch it live.
        </div>
      )}
    </div>
  );
}

/** Workgroup grid that fills as the benchmark proceeds; the numbers beside it are real measurements. */
export function BenchViz({ s }: { s: ContributorState }) {
  const p = s.bench?.progress ?? 0;
  const cells = 24 * 10;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 90);
    return () => clearInterval(t);
  }, []);
  const lit = Math.floor(p * cells);
  const latest = s.bench?.samples.at(-1);
  const max = Math.max(1, ...(s.bench?.samples ?? [1]));
  return (
    <div>
      <div className="label mb-3 flex items-center gap-2 text-signal">
        <span className="size-1.5 animate-pulse rounded-full bg-signal" /> Benchmarking your GPU…
      </div>
      <div className="rounded-xl bg-ink p-4">
        <div className="grid gap-[3px]" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}>
          {Array.from({ length: cells }, (_, i) => {
            const on = i < lit;
            const flicker = !on && i < lit + 24 && (i * 7 + tick) % 5 === 0;
            return <span key={i} className={cx("aspect-square rounded-[1.5px]", on ? "bg-signal" : flicker ? "bg-signal/50" : "bg-chalk/[0.08]")} />;
          })}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3 font-mono text-[11px] text-chalk/70">
          <div>
            <div className="text-chalk/40">phase</div>
            <div className="mt-1 text-chalk">{s.bench?.phase ?? "warmup"}</div>
          </div>
          <div>
            <div className="text-chalk/40">local throughput</div>
            <div className="mt-1 text-chalk">{latest ? `${(latest / 1e9).toFixed(2)} G rounds/s` : "—"}</div>
          </div>
          <div>
            <div className="text-chalk/40">samples</div>
            <div className="mt-1 flex h-4 items-end gap-[2px]">
              {(s.bench?.samples ?? []).map((v, i) => (
                <span key={i} className="w-1.5 bg-signal" style={{ height: `${Math.max(12, (v / max) * 100)}%` }} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <p className="mt-3 font-mono text-[11px] text-ink/45">Local readings are display-only. The score below comes from the server&apos;s clock.</p>
    </div>
  );
}

export function BenchResult({ s }: { s: ContributorState }) {
  const b = s.benchmark!;
  const sim = useSim();
  const top = Math.max(1, Math.round((1 - b.percentile) * 100));
  return (
    <div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-ink/10">
        <div className="bg-paper p-4">
          <div className="label flex items-center gap-2 text-ink/50">
            Compute score <Prov p="live" />
          </div>
          <div className="num mt-2 text-[40px] font-medium leading-none md:text-[48px]">{fmtInt(b.computeScore ?? 0)}</div>
        </div>
        <div className="bg-paper p-4">
          <div className="label flex items-center gap-2 text-ink/50">
            {sim ? "Est. network class" : "Verified"} <Prov p={sim ? "estimated" : "live"} />
          </div>
          <div className="num mt-2 text-[40px] font-medium leading-none md:text-[48px]">{sim ? `TOP ${top}%` : b.verified ? "YES" : "NO"}</div>
        </div>
      </div>
      <div className="mt-3 border-t border-ink/10 font-mono text-[11.5px]">
        {[
          ["kernel", `${b.kernel} · ${fmtInt(b.dims.m)} threads × ${fmtInt(b.dims.k)} rounds`],
          ["server-timed", `${fmtInt(b.serverElapsedMs ?? 0)} ms (trusted)`],
          ["client GPU time", `${fmtInt(b.clientElapsedMs)} ms (reported)`],
          ["verification", "secret blocks recomputed on server ✓"],
          ...(sim ? [["class percentile", "vs. simulated network distribution"]] : []),
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 border-b border-ink/10 py-2">
            <span className="text-ink/50">{k}</span>
            <span className="text-right">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const kindLabel: Record<string, string> = { tensor: "TENSOR MATMUL", embedding: "EMBEDDING MATVEC", verification: "VERIFICATION", inference: "INFERENCE" };

export function JobRow({ j }: { j: ContributorState["log"][number] }) {
  const ok = j.status === "verified";
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className="grid grid-cols-[1fr_auto] gap-x-4 border-b border-chalk/[0.07] py-3 font-mono text-[12px]"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-chalk">JOB #{j.id}</span>
          <span className="truncate text-chalk/45">{kindLabel[j.kind] ?? j.kind}</span>
        </div>
        <div className="mt-1 truncate text-[11px] text-chalk/35">{j.model}</div>
      </div>
      <div className="text-right">
        <div className={cx(ok ? "text-ok" : j.status === "failed" ? "text-signal" : "text-chalk/60")}>
          {ok ? "verified" : j.status === "failed" ? `rejected${j.reason ? ` · ${j.reason}` : ""}` : j.status}
        </div>
        <div className="mt-1 text-[11px] text-chalk/45">
          {j.gpuMs != null && `${Math.round(j.gpuMs)}ms gpu`}
          {j.units ? ` · +${j.units} units` : ""}
          {ok ? <span className={j.parentId ? "text-ok" : "text-chalk/35"}> · {j.parentId ? "customer job" : "subsidized"}</span> : null}
        </div>
      </div>
    </motion.div>
  );
}

/** Big status line over the topology during the first moments after joining. */
export function MomentTicker({ s }: { s: ContributorState }) {
  const cur = s.current;
  let line: { k: string; text: string; tone: string; sub?: string } | null = null;
  if (s.phase === "joining") line = { k: "join", text: `NODE ${s.node?.id} JOINED`, tone: "text-signal", sub: `+${fmtInt(s.node?.computeScore ?? 0)} COMPUTE` };
  else if (s.phase === "running" && cur) {
    const first = !s.firstJobDone;
    if (cur.status === "received") line = { k: `r${cur.id}`, text: first ? "FIRST JOB RECEIVED…" : `JOB #${cur.id} RECEIVED`, tone: "text-chalk", sub: cur.model };
    else if (cur.status === "computing") line = { k: `c${cur.id}`, text: "COMPUTING…", tone: "text-signal", sub: `on your GPU · ${cur.model}` };
    else if (cur.status === "verifying") line = { k: `v${cur.id}`, text: "VERIFYING…", tone: "text-chalk", sub: "server recomputing secret samples" };
    else if (cur.status === "verified")
      line = { k: `d${cur.id}`, text: "VERIFIED.", tone: "text-ok", sub: `+${cur.units} units` };
    else if (cur.status === "failed") line = { k: `f${cur.id}`, text: "REJECTED.", tone: "text-signal", sub: cur.reason };
  }
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 right-4 md:bottom-6 md:left-6">
      <AnimatePresence mode="wait">
        {line && (
          <motion.div key={line.k} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }}>
            <div className={cx("num text-[24px] font-semibold tracking-[-0.02em] md:text-[34px]", line.tone)}>{line.text}</div>
            {line.sub && <div className="mt-1 font-mono text-[12px] text-chalk/55">{line.sub}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
