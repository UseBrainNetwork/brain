"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Prov } from "@/components/ui";
import { cx, fmtInt } from "@/lib/format";
import { contributor, useContributor } from "@/network/client/contributor";
import { loadIdentity } from "@/network/client/identity";
import { useReal } from "@/network/realtime/real";

/**
 * /node — the screen a contributing device shows. Full-screen, dark, legible from across a desk.
 * Everything displayed is this device's real state: the node id is its persistent identity, the
 * GPU name is only shown when the browser exposes it, and credited units come from the server.
 */

type Screen = "join" | "detecting" | "benchmarking" | "waiting" | "received" | "computing" | "verifying" | "verified" | "failed" | "unsupported" | "error" | "stopped";

function screenOf(s: ReturnType<typeof useContributor>): Screen {
  if (s.phase === "unsupported") return "unsupported";
  if (s.phase === "error") return "error";
  if (s.phase === "stopped") return "stopped";
  if (s.phase === "detecting") return "detecting";
  if (s.phase === "benchmarking" || s.phase === "joining" || s.phase === "benchmarked") return "benchmarking";
  if (s.phase !== "running") return "join";
  const c = s.current;
  if (!c) return "waiting";
  return c.status === "received" ? "received" : c.status === "computing" ? "computing" : c.status === "verifying" ? "verifying" : c.status === "verified" ? "verified" : "failed";
}

const unitLabel = (unitId?: string, parentId?: string) => (unitId && parentId ? `#${parentId}-${unitId.slice(parentId.length + 1).replace(/#\d+$/, "")}` : "");

function GpuActivity({ active }: { active: boolean }) {
  const cells = 24 * 5;
  const [tick, setTick] = useState(0);
  // /node?autostart=1: detect → benchmark → join without a click (used to bring a machine online from a link).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("autostart") !== "1") return;
    const t = setTimeout(() => void contributor.joinAsWorker(), 800);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((x) => x + 1), 70);
    return () => clearInterval(t);
  }, [active]);
  return (
    <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(24, minmax(0, 1fr))` }} aria-hidden>
      {Array.from({ length: cells }, (_, i) => {
        const on = active && ((i * 2654435761) >>> 0) % 7 === tick % 7;
        const warm = active && ((i * 40503) >>> 0) % 5 === (tick + 2) % 5;
        return <span key={i} className={cx("aspect-square rounded-[1.5px] transition-colors duration-150", on ? "bg-signal" : warm ? "bg-chalk/40" : active ? "bg-chalk/[0.1]" : "bg-chalk/[0.05]")} />;
      })}
    </div>
  );
}

export function NodeScreen() {
  const s = useContributor();
  const screen = screenOf(s);
  const [identityId, setIdentityId] = useState<string | null>(null);
  useEffect(() => setIdentityId(loadIdentity().id), []);
  const nodeId = s.node?.id ?? identityId;
  const realNodes = useReal((r) => Object.keys(r.nodes).length);
  const gpu = s.detection?.gpuName.value;
  const last = s.log[0];
  const unit = s.current ?? (screen === "verified" || screen === "failed" ? last : undefined);

  const status = useMemo(() => {
    switch (screen) {
      case "join":
        return "READY TO JOIN";
      case "detecting":
        return "DETECTING GPU";
      case "benchmarking":
        return s.phase === "joining" ? "JOINING NETWORK" : "BENCHMARKING";
      case "waiting":
        return "WAITING FOR WORK";
      case "received":
        return "JOB RECEIVED";
      case "computing":
        return "COMPUTING";
      case "verifying":
        return "VERIFYING";
      case "verified":
        return "VERIFIED";
      case "failed":
        return "REJECTED";
      case "unsupported":
        return "WEBGPU UNAVAILABLE";
      case "error":
        return "DISCONNECTED";
      case "stopped":
        return "STOPPED";
    }
  }, [screen, s.phase]);

  const connected = s.phase === "running";
  const working = screen === "received" || screen === "computing" || screen === "verifying";

  return (
    <div data-theme="dark" className="surface-dark dotgrid-dark relative flex min-h-dvh flex-col font-mono">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 pt-6 text-[11px] uppercase tracking-[0.12em] text-chalk/50 md:px-10">
        <div className="flex items-center gap-3">
          <span className="text-chalk">BRAIN</span>
          <span>NODE</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-2">
            <span className={cx("inline-block size-[6px]", connected ? "bg-ok animate-pulse-dot" : "bg-chalk/30")} />
            {connected ? "CONNECTED" : "OFFLINE"}
          </span>
          <span className="hidden sm:inline">
            {realNodes} REAL {realNodes === 1 ? "NODE" : "NODES"} <Prov p="live" />
          </span>
        </div>
      </div>

      {/* Main */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="text-[11px] uppercase tracking-[0.18em] text-chalk/40">Node</div>
        <div className="display mt-2 font-sans text-[clamp(56px,12vw,160px)] leading-none text-chalk">{nodeId ?? "······"}</div>
        <div className="mt-3 text-[12px] text-chalk/45">
          {screen === "unsupported" ? "NO WEBGPU ADAPTER" : gpu ? gpu : s.detection ? "UNKNOWN GPU" : "GPU NOT YET DETECTED"}
          {s.benchmark?.verified && (
            <>
              {" · "}
              SCORE {fmtInt(s.benchmark.computeScore ?? 0)} <Prov p="live" />
            </>
          )}
        </div>

        <div className="mt-14 h-[150px] w-full max-w-[560px]">
          <AnimatePresence mode="wait">
            <motion.div key={screen} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.25 }}>
              <div
                className={cx(
                  "text-[clamp(26px,4.5vw,44px)] font-medium tracking-[0.04em]",
                  screen === "verified" ? "text-ok" : screen === "failed" || screen === "error" || screen === "unsupported" ? "text-signal" : working ? "text-chalk" : "text-chalk/80",
                )}
              >
                {status}
                {screen === "verified" && " ✓"}
                {screen === "failed" && " ✕"}
                {(screen === "waiting" || screen === "computing" || screen === "verifying" || screen === "detecting" || screen === "benchmarking") && <span className="animate-blink">…</span>}
              </div>

              {unit && (screen === "received" || screen === "computing" || screen === "verifying") && (
                <div className="mt-4 text-[13px] text-chalk/55">
                  WORK UNIT {unitLabel(unit.unitId, unit.parentId) || `#${unit.id}`} · {unit.model}
                </div>
              )}
              {screen === "verified" && last && (
                <div className="mt-4 text-[clamp(18px,3vw,28px)] text-ok">
                  +{fmtInt(last.units ?? 0)} COMPUTE UNITS <Prov p="live" className="align-middle" />
                </div>
              )}
              {screen === "failed" && last && <div className="mt-4 text-[13px] text-signal/80">{last.reason ?? "verification failed"} · no credit</div>}
              {screen === "unsupported" && (
                <div className="mt-4 text-[13px] text-chalk/55">This browser can&apos;t run WebGPU. Use Chrome or Edge on a desktop or laptop.</div>
              )}
              {screen === "error" && <div className="mt-4 text-[13px] text-chalk/55">{s.error}</div>}
              {screen === "benchmarking" && s.bench && (
                <div className="mx-auto mt-5 h-1 w-full max-w-[320px] overflow-hidden rounded-full bg-chalk/10">
                  <motion.span className="block h-full bg-signal" animate={{ width: `${Math.max(3, s.bench.progress * 100)}%` }} transition={{ ease: "linear", duration: 0.2 }} />
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="mt-6 w-full max-w-[420px]">
          <GpuActivity active={screen === "computing"} />
        </div>

        <div className="mt-12 flex min-h-[48px] items-center gap-4">
          {(screen === "join" || screen === "stopped" || screen === "error") && (
            <button
              type="button"
              onClick={() => void contributor.joinAsWorker()}
              className="h-14 rounded-full bg-chalk px-10 font-sans text-[16px] font-semibold tracking-tight text-ink transition hover:bg-white active:scale-[0.98]"
            >
              {screen === "join" ? "JOIN NETWORK" : "REJOIN NETWORK"}
            </button>
          )}
          {connected && (
            <button type="button" onClick={() => void contributor.stop()} className="text-[11px] uppercase tracking-[0.12em] text-chalk/35 hover:text-chalk">
              Leave network
            </button>
          )}
        </div>
      </div>

      {/* Footer stats */}
      <div className="grid grid-cols-3 gap-px border-t border-chalk/[0.08] bg-chalk/[0.06] text-[11px] uppercase tracking-[0.1em]">
        {[
          ["Units verified", String(s.jobsCompleted)],
          ["Compute credited", fmtInt(s.verifiedUnits)],
          ["Rejected", String(s.jobsFailed)],
        ].map(([k, v]) => (
          <div key={k} className="bg-ink px-6 py-4 md:px-10">
            <div className="text-chalk/40">{k}</div>
            <div className="num mt-1 text-[20px] text-chalk">{v}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between px-6 py-3 text-[10px] uppercase tracking-[0.1em] text-chalk/30 md:px-10">
        <span>Anonymous persistent id · no IP or personal data shown</span>
        <Link href="/demo" className="hover:text-chalk">
          Open network view →
        </Link>
      </div>
    </div>
  );
}
