"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { notify, requestNotifyPermission } from "@/lib/notify";
import { EventFeed } from "@/components/network/EventFeed";
import { GpuCounter, LiveNodeCount } from "@/components/network/Metrics";
import { SimOnly } from "@/components/layout/SimOnly";
import { ComputeDie } from "@/components/network/ComputeDie";
import { Button, Dot, Prov } from "@/components/ui";
import { PayoutEmail } from "@/components/wallet/PayoutEmail";
import { WalletModal } from "@/components/wallet/WalletButton";
import { contributor, useContributor, type ContributorState } from "@/network/client/contributor";
import { useWallet, walletStore } from "@/lib/wallet/store";
import { deviceLabel } from "@/services/mock/mockData";
import { cx, fmtDuration, fmtInt, fmtPct, fmtSol, fmtUsd, shortAddr, ineligibleCopy } from "@/lib/format";
import type { NodeEconomics } from "@/services/nodeProfile";
import type { RewardsSummary } from "@/domain/types";
import { BenchResult, BenchViz, DeviceReport, JobRow, MomentTicker, StepShell } from "./parts";

export function ContributeFlow() {
  const s = useContributor();
  const w = useWallet();
  const [walletOpen, setWalletOpen] = useState(false);

  useEffect(() => {
    if (s.phase === "idle") void contributor.detect();
  }, [s.phase]);

  const joined = s.phase === "joining" || s.phase === "running";

  // Native notification the moment the node is accepted. Fires once per join.
  const notifiedRef = useRef(false);
  useEffect(() => {
    if (s.phase === "running" && !notifiedRef.current) {
      notifiedRef.current = true;
      notify("Your node is live", "Receiving verified jobs from the network.", "brain-node");
    }
    if (s.phase !== "running" && s.phase !== "joining") notifiedRef.current = false;
  }, [s.phase]);
  const ready = s.detection?.webgpu === "ready";
  const benchStarted = s.phase === "benchmarking" || Boolean(s.benchmark);
  const benchDone = Boolean(s.benchmark) && s.phase !== "stopped";
  const canJoin = benchDone;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,520px)_1fr] lg:gap-8">
      {/* Control column */}
      <div className="space-y-3">
        <AnimatePresence mode="popLayout" initial={false}>
          {joined ? (
            <motion.div key="dash" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <NodeDashboard s={s} onWallet={() => setWalletOpen(true)} />
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

              <StepShell n="3" title="Join network" state={canJoin ? "current" : "locked"} open={canJoin}>
                {canJoin && (
                  <div>
                    <p className="text-[14px] leading-relaxed text-ink/65">
                      Your node becomes visible to the network and starts receiving jobs the server verifies. Verified work earns credits, USDC or SOL. Keep this tab open. Stop whenever you want.
                    </p>
                    <Button
                      variant="signal"
                      className="mt-5 h-14 w-full text-[16px]"
                      onClick={() => {
                        void requestNotifyPermission();
                        void contributor.join();
                      }}
                      arrow
                    >
                      Join network
                    </Button>
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 font-mono text-[11.5px] text-ink/50">
                      <span>
                        {w.status === "connected" && w.address ? (
                          <>wallet {shortAddr(w.address)} will be linked to this node</>
                        ) : (
                          <>
                            Optional:{" "}
                            <button onClick={() => setWalletOpen(true)} className="text-ink/75 underline-offset-2 hover:underline">
                              connect a wallet
                            </button>{" "}
                            so earnings follow you and USDC or SOL can settle to it. You can do it after joining.
                          </>
                        )}
                      </span>
                    </div>
                  </div>
                )}
              </StepShell>
              {s.phase === "stopped" && (
                <div className="rounded-[20px] bg-paper p-5 text-[14px]">
                  Node stopped. {fmtInt(s.node?.verifiedComputeUnits ?? s.verifiedUnits)} verified units this session.{" "}
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
            <div className="flex items-center gap-3 font-mono text-[12px]">
              <span className="flex items-center gap-2">
                <LiveNodeCount className={cx("text-[15px] font-semibold", joined ? "text-signal" : "text-chalk")} />
                <span className="text-chalk/50">real nodes</span>
                <Prov p="live" />
              </span>
              <SimOnly>
                <span className="hidden items-center gap-2 text-chalk/40 sm:flex">
                  <GpuCounter className="text-[13px]" />
                  <span>demo</span>
                  <Prov p="simulated" />
                </span>
              </SimOnly>
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

function NodeDashboard({ s, onWallet }: { s: ContributorState; onWallet: () => void }) {
  const w = useWallet();
  const [now, setNow] = useState(Date.now());
  const [eco, setEco] = useState<NodeEconomics | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const nodeId = s.node?.id;
  useEffect(() => {
    if (!nodeId) return;
    let stop = false;
    const load = () =>
      fetch(`/api/nodes/${nodeId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => !stop && d?.economics && setEco(d.economics))
        .catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [nodeId]);
  // The node's real position in hourly settlement: projected share of the open epoch + settled, claimable SOL.
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
  const status = s.phase === "joining" ? "JOINING" : s.current?.status === "computing" ? "COMPUTING" : s.current?.status === "verifying" ? "VERIFYING" : "ONLINE";

  const cells: [string, string, "live" | "estimated" | "simulated" | null][] = [
    ["Device", deviceLabel(s.node?.deviceClass ?? "OTHER_WEBGPU"), null],
    ["Session", s.startedAt ? fmtDuration(now - s.startedAt) : "00:00:00", null],
    ["Jobs completed", fmtInt(s.jobsCompleted), "live"],
    ["Verified compute", `${fmtInt(s.node?.verifiedComputeUnits ?? s.verifiedUnits)} units`, "live"],
    ["Reputation", (s.node?.reputation ?? 0).toFixed(2), "live"],
    ["Compute score", fmtInt(s.node?.computeScore ?? 0), "live"],
    ["Customer jobs", eco ? fmtInt(eco.customerJobs) : "—", "live"],
    ["Subsidized jobs", eco ? fmtInt(eco.subsidizedJobs) : "—", "live"],
  ];
  const accrued = eco?.customerFundedUsd ?? null;

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

      {!linked && (
        <div className="border-t border-warn/30 bg-warn/[0.1] px-5 py-4 md:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="label text-warn">Not linked · this node is earning nothing</div>
              <div className="mt-1 max-w-[520px] text-[13.5px] leading-snug text-chalk/80">
                Rewards settle every hour to wallets linked to verified work. Your {fmtInt(s.jobsCompleted)} verified jobs count toward reputation, but no SOL is allocated to this node until a wallet is linked.
              </div>
              {w.status === "error" && w.error && <div className="mt-1.5 font-mono text-[11px] text-signal">{w.error}</div>}
            </div>
            <Button tone="dark" className="h-10 px-5 text-[14px]" onClick={onWallet} disabled={w.status === "connecting" || w.status === "signing"}>
              {w.status === "signing" ? "Sign in wallet…" : w.status === "connecting" ? "Connecting…" : w.status === "error" ? "Try again" : "Link wallet to get paid"}
            </Button>
          </div>
        </div>
      )}
      <div className="grid gap-px bg-chalk/[0.07] sm:grid-cols-3">
        <div className="bg-ink-2 px-5 py-4 md:px-6">
          <div className="label flex items-center gap-1.5 text-chalk/45">
            This hour <Prov p="estimated" />
          </div>
          <div className={cx("num mt-1.5 text-[22px]", linked && rw ? "text-chalk" : "text-chalk/50")}>{linked ? (rw ? `~${fmtSol(rw.current.projectedLamports)}` : "…") : "0 SOL"}</div>
          <div className="mt-1 font-mono text-[11px] leading-relaxed text-chalk/40">
            {linked
              ? rw
                ? `${fmtInt(rw.current.verifiedCompute)} of ${fmtInt(rw.current.networkVerifiedCompute)} network units · epoch ${rw.current.epochId.slice(2)} · settles on the hour`
                : "Loading your share of the open epoch…"
              : "Projected share of the open epoch. Needs a linked wallet."}
            {linked && rw && !rw.current.eligible && <span className="mt-1 block text-warn/80">{ineligibleCopy(rw.current.ineligibleReason, rw.current.verificationPassRate)}</span>}
          </div>
        </div>
        <div className="bg-ink-2 px-5 py-4 md:px-6">
          <div className="label flex items-center gap-1.5 text-chalk/45">
            Claimable <Prov p="live" />
          </div>
          <div className={cx("num mt-1.5 text-[22px]", linked && rw && rw.claimableLamports > 0 ? "text-ok" : "text-chalk/50")}>{linked && rw ? fmtSol(rw.claimableLamports) : "0 SOL"}</div>
          <div className="mt-1 font-mono text-[11px] leading-relaxed text-chalk/40">
            {linked && rw ? (
              <>
                {fmtSol(rw.earnedLamports)} settled · {fmtSol(rw.claimedLamports, false)} claimed ·{" "}
                <Link href="/rewards" className="text-chalk/70 underline-offset-2 hover:underline">
                  claim →
                </Link>
              </>
            ) : (
              "Settled epochs, minus what you have claimed."
            )}
          </div>
        </div>
        <div className="bg-ink-2 px-5 py-4 md:px-6">
          <div className="label flex items-center gap-1.5 text-chalk/45">Wallet</div>
          {w.status === "connected" && w.address ? (
            <>
              <div className="num mt-1.5 text-[18px]">{shortAddr(w.address)}</div>
              <div className="mt-1 font-mono text-[11px] text-chalk/40">
                {w.verified ? "linked · rewards settle to this wallet" : "demo wallet · not linked"} · {w.holding?.supplyShare != null ? `${fmtPct(w.holding.supplyShare, 3)} of supply` : "holdings unknown"}
              </div>
              <PayoutEmail className="mt-1.5" />
            </>
          ) : (
            <>
              <div className="num mt-1.5 text-[18px] text-chalk/50">none</div>
              <div className="mt-1 font-mono text-[11px] text-chalk/40">Phantom, Solflare, Backpack or email. One signature; moves no funds.</div>
            </>
          )}
        </div>
      </div>
      {accrued != null && (
        <div className="border-t border-chalk/[0.07] bg-ink-2 px-5 py-3 font-mono text-[11px] leading-relaxed text-chalk/50 md:px-6">
          Customer-funded work: {fmtUsd(accrued)} owed at list price, usable as credits now.
        </div>
      )}
      <div className="border-t border-chalk/[0.07] bg-warn/[0.06] px-5 py-3 font-mono text-[11px] leading-relaxed text-warn md:px-6">
        50% of claimed creator fees is paced out hourly to linked wallets by verified compute. Zero verified compute earns zero. No return is promised.
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
          Same ledger as your{" "}
          <Link href="/account" className="text-chalk/70 underline-offset-2 hover:text-signal hover:underline">
            account →
          </Link>
        </span>
        <Button tone="dark" variant="secondary" className="h-9 px-4 text-[13px]" onClick={() => contributor.stop()}>
          Stop
        </Button>
      </div>
    </div>
  );
}
