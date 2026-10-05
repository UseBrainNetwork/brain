"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Prov } from "@/components/ui";
import { PayoutEmail } from "@/components/wallet/PayoutEmail";
import { WalletButton } from "@/components/wallet/WalletButton";
import type { RewardsSummary } from "@/domain/types";
import { cx, fmtInt, fmtSol, shortAddr } from "@/lib/format";
import { useKeepAwake } from "@/lib/keepAwake";
import { useWallet } from "@/lib/wallet/store";
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

/**
 * The strip that decides whether this device gets paid. Hourly settlement only allocates to nodes with a
 * signature-linked wallet, so an unlinked node must say so loudly; a linked one shows its real position.
 */
function WalletStrip({ connected, jobs }: { connected: boolean; jobs: number }) {
  const w = useWallet();
  const linked = w.status === "connected" && w.verified ? w.address : null;
  const [rw, setRw] = useState<RewardsSummary | null>(null);
  useEffect(() => {
    if (!linked) return setRw(null);
    let stop = false;
    const load = () =>
      fetch(`/api/rewards/summary?address=${encodeURIComponent(linked)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => !stop && d?.current && setRw(d))
        .catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [linked]);

  if (linked) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-chalk/[0.08] px-6 py-3 text-[11px] uppercase tracking-[0.1em] md:px-10">
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-chalk/60">
          <span className="flex items-center gap-2">
            <span className="inline-block size-[6px] bg-ok" /> Wallet {shortAddr(linked)} · linked
          </span>
          <PayoutEmail dark className="normal-case tracking-normal" />
        </span>
        <span className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <span className="text-chalk/60">
            This hour <span className="text-chalk">{rw ? `~${fmtSol(rw.current.projectedLamports)}` : "…"}</span> <Prov p="estimated" />
          </span>
          <span className="text-chalk/60">
            Claimable <span className={rw && rw.claimableLamports > 0 ? "text-ok" : "text-chalk"}>{rw ? fmtSol(rw.claimableLamports) : "…"}</span> <Prov p="live" />
          </span>
          <Link href="/rewards" className="text-chalk/70 hover:text-chalk">
            Rewards →
          </Link>
        </span>
      </div>
    );
  }
  return (
    <div className={cx("flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t px-6 py-3.5 md:px-10", connected ? "border-warn/30 bg-warn/[0.08]" : "border-chalk/[0.08]")}>
      <div className="text-[11px] uppercase tracking-[0.1em]">
        <div className={connected ? "text-warn" : "text-chalk/60"}>{connected ? "No wallet linked · this node is earning nothing" : "No wallet linked"}</div>
        <div className="mt-1 normal-case tracking-normal text-chalk/55">
          {connected && jobs > 0 ? `${fmtInt(jobs)} verified ${jobs === 1 ? "job" : "jobs"} so far count for reputation only. ` : ""}
          Rewards settle every hour to linked wallets by verified compute. One signature; moves no funds.
          {w.status === "error" && w.error && <span className="text-signal"> {w.error}</span>}
        </div>
      </div>
      <WalletButton dark className="h-10 px-5" />
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
  const awake = useKeepAwake(connected);
  // When the tab comes back after being hidden a while, say so for a bit; while hidden, the tab title says so.
  const [cameBack, setCameBack] = useState(0);
  const hiddenForRef = useRef(0);
  hiddenForRef.current = awake.hiddenFor;
  useEffect(() => {
    if (!connected) return;
    if (awake.hidden) {
      const prev = document.title;
      document.title = "⏸ BRAIN node in background · work slows";
      return () => {
        document.title = prev;
        if (hiddenForRef.current >= 20) setCameBack(hiddenForRef.current);
      };
    }
  }, [awake.hidden, connected]);
  useEffect(() => {
    if (!cameBack) return;
    const t = setTimeout(() => setCameBack(0), 25_000);
    return () => clearTimeout(t);
  }, [cameBack]);

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
          {connected && awake.wakeLock === "held" && (
            <span className="hidden items-center gap-2 md:flex" title="Screen Wake Lock held: the display will not sleep while this node is active.">
              <span className="inline-block size-[6px] bg-ok/70" /> SCREEN AWAKE
            </span>
          )}
        </div>
      </div>

      {connected && (cameBack > 0 || awake.wakeLock !== "held") && (
        <div className={cx("mx-6 mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 rounded-[10px] border px-4 py-2.5 text-[11.5px] normal-case tracking-normal md:mx-10", cameBack > 0 ? "border-warn/40 bg-warn/[0.08] text-warn" : "border-chalk/10 bg-chalk/[0.03] text-chalk/55")}>
          <span>
            {cameBack > 0
              ? `This tab was in the background for ${cameBack >= 60 ? `${Math.round(cameBack / 60)} min` : `${cameBack}s`}. Browsers throttle hidden tabs, so work slows or stalls while it is hidden.`
              : "Keep this tab in front. Browsers throttle hidden tabs and may sleep the display; a separate window on its own works best."}
          </span>
          {awake.wakeLock === "unsupported" && <span className="text-chalk/40">Screen wake lock not available in this browser.</span>}
          {cameBack > 0 && (
            <button type="button" onClick={() => setCameBack(0)} className="text-warn/80 hover:text-warn">
              dismiss
            </button>
          )}
        </div>
      )}

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

      <WalletStrip connected={connected} jobs={s.jobsCompleted} />

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
