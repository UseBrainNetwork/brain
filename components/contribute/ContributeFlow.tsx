"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { EventFeed } from "@/components/network/EventFeed";
import { GpuCounter } from "@/components/network/Metrics";
import { ComputeDie } from "@/components/network/ComputeDie";
import { Button, Dot, Prov } from "@/components/ui";
import { WalletModal } from "@/components/wallet/WalletButton";
import { contributor, useContributor, type ContributorState } from "@/network/client/contributor";
import { useWallet, walletStore } from "@/lib/wallet/store";
import { estimateReward } from "@/rewards/simulate";
import { deviceLabel } from "@/services/mock/mockData";
import { cx, fmtDuration, fmtInt, fmtPct, fmtUsdSmall, shortAddr } from "@/lib/format";
import { BenchResult, BenchViz, DeviceReport, JobRow, MomentTicker, StepShell } from "./parts";

export function ContributeFlow() {
  const s = useContributor();
  const w = useWallet();
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletSkipped, setWalletSkipped] = useState(false);

  useEffect(() => {
    if (s.phase === "idle") void contributor.detect();
  }, [s.phase]);

  const joined = s.phase === "joining" || s.phase === "running";
  const ready = s.detection?.webgpu === "ready";
  const benchStarted = s.phase === "benchmarking" || Boolean(s.benchmark);
  const benchDone = Boolean(s.benchmark) && s.phase !== "stopped";
  const walletDone = w.status === "connected" || walletSkipped;
  const canJoin = benchDone && walletDone;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,520px)_1fr] lg:gap-8">
      {/* Control column */}
      <div className="space-y-3">
        <AnimatePresence mode="popLayout" initial={false}>
          {joined ? (
            <motion.div key="dash" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <NodeDashboard s={s} />
            </motion.div>
          ) : (
            <motion.div key="steps" className="space-y-3" exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.3 }}>
              <StepShell
                n="1"
                title="Detect GPU"
                state={ready && benchStarted ? "done" : "current"}
                open={!benchStarted}
                aside={
                  s.phase === "detecting" ? (
                    <span className="label text-ink/50">reading adapter…</span>
                  ) : benchStarted ? (
                    <span className="max-w-[220px] truncate font-mono text-[12px] text-ink/60">{s.detection?.gpuName.value ?? "WebGPU adapter"}</span>
                  ) : null
                }
              >
                {s.detection ? <DeviceReport d={s.detection} /> : <DetectingSkeleton />}
              </StepShell>

              <StepShell n="2" title="Benchmark" state={benchDone ? "done" : ready ? "current" : "locked"} open={ready}>
                {s.phase === "benchmarking" ? (
                  <BenchViz s={s} />
                ) : s.benchmark && s.phase !== "stopped" ? (
                  <BenchResult s={s} />
                ) : (
                  <div>
                    <p className="text-[14px] leading-relaxed text-ink/65">
                      Runs a WGSL integer kernel on your GPU for under a second. The server sends a fresh random challenge, recomputes secret parts of your answer, and scores you by
                      its own clock.
                    </p>
                    <div className="mt-4 flex items-center gap-3">
                      <Button onClick={() => contributor.benchmark()}>Run benchmark</Button>
                      {s.phase === "error" && <span className="font-mono text-[12px] text-signal">{s.error}</span>}
                    </div>
                  </div>
                )}
              </StepShell>

              <StepShell
                n="3"
                title="Wallet"
                state={canJoin ? "done" : benchDone ? "current" : "locked"}
                open={benchDone}
                aside={w.status === "connected" && w.address ? <span className="font-mono text-[12px] text-ink/60">{shortAddr(w.address)}</span> : <span className="label text-ink/40">optional</span>}
              >
                {benchDone && <WalletStep s={s} onConnect={() => setWalletOpen(true)} onSkip={() => setWalletSkipped(true)} skipped={walletSkipped} />}
              </StepShell>

              <StepShell n="4" title="Join network" state={canJoin ? "current" : "locked"} open={canJoin}>
                {canJoin && (
                  <div>
                    <p className="text-[14px] leading-relaxed text-ink/65">
                      Your node becomes visible to the network and starts receiving verifiable jobs. Keep this tab open. You can stop any time.
                    </p>
                    <Button variant="signal" className="mt-5 h-14 w-full text-[16px]" onClick={() => contributor.join()} arrow>
                      Join network
                    </Button>
                  </div>
                )}
              </StepShell>
              {s.phase === "stopped" && (
                <div className="rounded-[20px] bg-paper p-5 text-[14px]">
                  Node stopped. Session earnings {fmtUsdSmall(s.sessionUsd)} (est.).{" "}
                  <button className="font-semibold underline underline-offset-2" onClick={() => contributor.reset()}>
                    Benchmark again to rejoin
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Network column */}
      <div className="lg:sticky lg:top-[88px] lg:self-start">
        <div data-theme="dark" className="overflow-hidden rounded-[22px] bg-[#0f0f0e] text-chalk ring-1 ring-black/40">
          <div className="flex items-center justify-between border-b border-chalk/[0.08] px-5 py-3">
            <div className="flex items-center gap-3">
              <Dot />
              <span className="label text-chalk/80">The network</span>
            </div>
            <div className="flex items-center gap-2 font-mono text-[12px]">
              <GpuCounter className={cx("text-[15px] font-semibold", joined ? "text-signal" : "text-chalk")} />
              <span className="text-chalk/50">GPUs online</span>
              <Prov p={joined ? "live" : "simulated"} />
            </div>
          </div>
          <div className="relative">
            <ComputeDie focusLocal className="h-[420px] md:h-[560px]" />
            <MomentTicker s={s} />
          </div>
          <div className="border-t border-chalk/[0.08] px-5 py-2">
            <div className="h-[178px] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_65%,transparent)]">
              <EventFeed limit={7} />
            </div>
          </div>
        </div>
      </div>
      {walletOpen && <WalletModal onClose={() => setWalletOpen(false)} />}
    </div>
  );
}

function DetectingSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="h-7 animate-pulse rounded bg-ink/[0.06]" style={{ animationDelay: `${i * 90}ms` }} />
      ))}
    </div>
  );
}

function WalletStep({ s, onConnect, onSkip, skipped }: { s: ContributorState; onConnect: () => void; onSkip: () => void; skipped: boolean }) {
  const w = useWallet();
  const score = s.benchmark?.computeScore ?? 0;
  const amount = w.holding?.amount ?? 0;
  const est = estimateReward({ computeScore: score, tokenAmount: amount });
  if (w.status !== "connected") {
    return (
      <div>
        <p className="text-[14px] leading-relaxed text-ink/65">
          Connect a Solana wallet to receive rewards. Holdings increase your reward weighting with diminishing returns. They never earn without verified compute.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={onConnect}>Connect wallet</Button>
          {!skipped && (
            <button onClick={onSkip} className="text-[13.5px] font-medium text-ink/55 underline-offset-2 hover:underline">
              Skip for now (1.00×)
            </button>
          )}
        </div>
        <div className="mt-4 font-mono text-[11px] text-ink/45">
          Without tokens: est. {fmtUsdSmall(estimateReward({ computeScore: score, tokenAmount: 0 }).dailyUsd)}/day <Prov p="estimated" />
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-ink/10">
        {[
          ["Your token holdings", `${fmtInt(amount)} BRAIN`, w.holding?.provenance ?? "simulated"],
          ["Supply share", fmtPct(w.holding?.supplyShare ?? 0, 3), w.holding?.provenance ?? "simulated"],
          ["GPU score", fmtInt(score), "live"],
          ["Reward multiplier", `${est.multiplier.toFixed(2)}×`, "estimated"],
        ].map(([k, v, p]) => (
          <div key={k} className="bg-paper p-3.5">
            <div className="label flex items-center gap-2 text-ink/50">
              {k} <Prov p={p as "live"} />
            </div>
            <div className="num mt-1.5 text-[22px] font-medium">{v}</div>
          </div>
        ))}
      </div>
      <div className="mt-px rounded-b-xl bg-ink p-4 text-chalk">
        <div className="label flex items-center gap-2 text-chalk/55">
          Estimated daily reward <Prov p="estimated" />
        </div>
        <div className="num mt-1.5 text-[34px] font-medium text-signal">{fmtUsdSmall(est.dailyUsd)}</div>
        <div className="mt-1 font-mono text-[11px] text-chalk/40">Illustrative: real formula, simulated network and revenue. Not a promise of returns.</div>
      </div>
      <div className="mt-3 flex items-center justify-between font-mono text-[11px] text-ink/50">
        <span>{w.verified ? "ownership verified by signature" : "demo wallet · not linked to payouts"}</span>
        <button className="underline-offset-2 hover:underline" onClick={() => walletStore.disconnect()}>
          disconnect
        </button>
      </div>
    </div>
  );
}

function NodeDashboard({ s }: { s: ContributorState }) {
  const w = useWallet();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const est = estimateReward({ computeScore: s.node?.computeScore ?? 0, tokenAmount: w.holding?.amount ?? 0 });
  const status = s.phase === "joining" ? "JOINING" : s.current?.status === "computing" ? "COMPUTING" : s.current?.status === "verifying" ? "VERIFYING" : "ONLINE";

  const cells: [string, string, "live" | "estimated" | "simulated" | null][] = [
    ["Device", deviceLabel(s.node?.deviceClass ?? "OTHER_WEBGPU"), null],
    ["Session", s.startedAt ? fmtDuration(now - s.startedAt) : "00:00:00", null],
    ["Jobs completed", fmtInt(s.jobsCompleted), "live"],
    ["Verified compute", `${fmtInt(s.node?.verifiedComputeUnits ?? s.verifiedUnits)} units`, "live"],
    ["Token share", fmtPct(w.holding?.supplyShare ?? 0, 3), w.holding?.provenance ?? null],
    ["Reward multiplier", `${est.multiplier.toFixed(2)}×`, "estimated"],
    ["Reputation", (s.node?.reputation ?? 0).toFixed(2), "live"],
    ["Compute score", fmtInt(s.node?.computeScore ?? 0), "live"],
  ];

  return (
    <div data-theme="dark" className="overflow-hidden rounded-[22px] bg-ink text-chalk">
      <div className="flex items-center justify-between px-5 pb-4 pt-5 md:px-6">
        <div>
          <div className="label text-chalk/50">Your node</div>
          <div className="num mt-1 text-[28px] font-semibold">NODE {s.node?.id}</div>
        </div>
        <div className="text-right">
          <div className="label text-chalk/50">Status</div>
          <div className="mt-1.5 flex items-center justify-end gap-2 font-mono text-[14px] font-semibold text-signal">
            <span className="size-2 animate-pulse rounded-full bg-signal" /> {status}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px bg-chalk/[0.07]">
        {cells.map(([k, v, p]) => (
          <div key={k} className="bg-ink px-5 py-3.5 md:px-6">
            <div className="label flex items-center gap-2 text-chalk/45">
              {k} {p && <Prov p={p} />}
            </div>
            <div className="num mt-1.5 text-[19px]">{v}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-px bg-chalk/[0.07]">
        {[
          ["Session earnings", s.sessionUsd],
          ["Today", s.todayUsd],
          ["All time", s.allTimeUsd],
        ].map(([k, v]) => (
          <div key={k as string} className="bg-ink-2 px-5 py-4 md:px-6">
            <div className="label flex items-center gap-1.5 text-chalk/45">
              {k} <Prov p="estimated" />
            </div>
            <div className="num mt-1.5 text-[22px] text-signal md:text-[24px]">{fmtUsdSmall(v as number)}</div>
          </div>
        ))}
      </div>

      <div className="px-5 pb-2 pt-5 md:px-6">
        <div className="flex items-center justify-between">
          <span className="label text-chalk/50">Live job activity</span>
          <span className="font-mono text-[11px] text-chalk/35">server-verified</span>
        </div>
        <div className="mt-2 max-h-[320px] overflow-y-auto">
          {s.current && s.current.status !== "verified" && s.current.status !== "failed" && (
            <div className="grid grid-cols-[1fr_auto] border-b border-chalk/[0.07] py-3 font-mono text-[12px]">
              <span>
                JOB #{s.current.id} <span className="text-chalk/45">{s.current.model}</span>
              </span>
              <span className="text-signal">{s.current.status}…</span>
            </div>
          )}
          {s.log.map((j) => (
            <JobRow key={j.id} j={j} />
          ))}
          {!s.log.length && !s.current && <div className="py-6 font-mono text-[12px] text-chalk/40">Waiting for first job…</div>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-chalk/[0.07] px-5 py-4 md:px-6">
        <span className="font-mono text-[11px] text-chalk/40">
          Earnings are estimates until the epoch settles.{" "}
          <Link href="/rewards" className="text-chalk/70 underline-offset-2 hover:text-signal hover:underline">
            See your rewards →
          </Link>
        </span>
        <Button tone="dark" variant="secondary" className="h-9 px-4 text-[13px]" onClick={() => contributor.stop()}>
          Stop
        </Button>
      </div>
    </div>
  );
}
