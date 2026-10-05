"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button, Prov } from "@/components/ui";
import { contributor, useContributor } from "@/network/client/contributor";
import { useSim } from "@/network/realtime/mode";
import { SimFallback } from "@/components/layout/SimOnly";
import { defaultRewardConfig } from "@/rewards/config";
import { estimateReward } from "@/rewards/simulate";
import { getDeviceClasses } from "@/services/data";
import { cx, fmtInt, fmtPct, fmtUsd, fmtUsdSmall } from "@/lib/format";

const cfg = defaultRewardConfig;
const PRESETS = [...getDeviceClasses()].sort((a, b) => b.medianScore - a.medianScore);
const TOKEN_STEPS = [0, 1_000_000, 2_500_000, 5_000_000, 10_000_000];

function Field({ label, value, children }: { label: string; value?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <span className="text-[13px] font-medium text-chalk/70">{label}</span>
        {value != null && <span className="num text-[13px] text-chalk">{value}</span>}
      </div>
      {children}
    </div>
  );
}

function Range({ value, min, max, step, onChange, label }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="range-signal h-1.5 w-full cursor-pointer appearance-none rounded-full"
      style={{ background: `linear-gradient(90deg, var(--color-signal) ${pct}%, rgba(230,233,238,0.12) ${pct}%)` }}
    />
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "rounded-full px-3 py-1.5 font-mono text-[11.5px] transition-colors",
        on ? "bg-chalk text-ink" : "bg-chalk/[0.06] text-chalk/60 ring-1 ring-inset ring-chalk/10 hover:text-chalk",
      )}
    >
      {children}
    </button>
  );
}

/** Runs the real protocol: detect → server-issued challenge → server-timed, verified score. */
async function measure() {
  await contributor.detect();
  await contributor.benchmark();
}

/** Inline GPU test. The score it produces is the same one the network pays on. */
function MeasurePanel({ me, selected }: { me: ReturnType<typeof useContributor>; selected: boolean }) {
  const b = me.benchmark;
  if (me.phase === "benchmarking" || me.phase === "detecting") {
    const p = me.bench?.progress ?? 0;
    const latest = me.bench?.samples.at(-1);
    return (
      <div className="rounded-xl bg-ink p-4 ring-1 ring-chalk/[0.08]">
        <div className="flex items-center justify-between font-mono text-[11px]">
          <span className="flex items-center gap-2 text-signal">
            <span className="size-1.5 animate-pulse rounded-full bg-signal" />
            {me.phase === "detecting" ? "Detecting GPU…" : `Benchmarking · ${me.bench?.phase ?? "warmup"}`}
          </span>
          <span className="text-chalk/50">{latest ? `${(latest / 1e9).toFixed(2)} G rounds/s` : "—"}</span>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-chalk/[0.08]">
          <motion.span className="block h-full bg-signal" animate={{ width: `${Math.max(4, p * 100)}%` }} transition={{ ease: "linear", duration: 0.2 }} />
        </div>
        <p className="mt-3 font-mono text-[10.5px] text-chalk/35">Local readings are display-only. The server scores you by its own clock.</p>
      </div>
    );
  }
  if (b?.verified && b.computeScore != null) {
    const top = Math.max(1, Math.round((1 - b.percentile) * 100));
    return (
      <div className={cx("rounded-xl p-4 ring-1 transition-colors", selected ? "bg-ink ring-signal/50" : "bg-ink ring-chalk/[0.08]")}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <div className="label flex items-center gap-2 text-chalk/50">
              Your GPU, measured <Prov p="live" />
            </div>
            <div className="mt-1.5 truncate text-[15px] font-medium text-chalk">{me.detection?.gpuName.value ?? "WebGPU adapter"}</div>
          </div>
          <div className="text-right">
            <div className="num text-[28px] font-medium leading-none text-chalk">{fmtInt(b.computeScore)}</div>
            <div className="mt-1 font-mono text-[10.5px] text-chalk/45">
              server-timed {fmtInt(b.serverElapsedMs ?? 0)} ms · top {top}% <Prov p="estimated" />
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-chalk/10 pt-3 font-mono text-[11px] text-chalk/50">
          <span>{me.phase === "running" ? "Node live and earning" : "Node registered on standby"}</span>
          <Link href="/earn" className="text-chalk hover:text-signal">
            {me.phase === "running" ? "View node →" : "Join network to start earning →"}
          </Link>
        </div>
      </div>
    );
  }
  const unsupported = me.detection && me.detection.webgpu !== "ready";
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-ink p-4 ring-1 ring-chalk/[0.08] sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-chalk">Test your actual GPU</div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-chalk/50">
          {unsupported
            ? "WebGPU isn't available in this browser. Use Chrome or Edge on desktop, or pick a preset below."
            : me.phase === "error"
              ? `Benchmark failed: ${me.error}. Try again or pick a preset.`
              : "About one second. Runs a real WGSL kernel; the server times and verifies the result."}
        </p>
      </div>
      {!unsupported && (
        <Button tone="dark" className="shrink-0" onClick={() => void measure()}>
          Measure my GPU
        </Button>
      )}
    </div>
  );
}

/** Contributor-facing front-end for rewards/formula.ts, evaluated against the simulated network. */
export function EarningsCalculator({ compact = false }: { compact?: boolean }) {
  const me = useContributor();
  const measured = me.benchmark?.verified ? me.benchmark.computeScore : undefined;
  const [score, setScore] = useState(PRESETS.find((p) => p.id === "RTX_4080")!.medianScore);
  // A fresh measurement always wins over a preset guess.
  useEffect(() => {
    if (measured != null) setScore(measured);
  }, [measured]);
  const [hours, setHours] = useState(20);
  const [tokens, setTokens] = useState(2_500_000);
  const [showFormula, setShowFormula] = useState(false);
  const availability = hours / 24;

  const est = useMemo(() => estimateReward({ computeScore: score, tokenAmount: tokens, availability }), [score, tokens, availability]);
  const base = useMemo(() => estimateReward({ computeScore: score, tokenAmount: 0, availability }), [score, availability]);
  const holdOnly = useMemo(() => estimateReward({ computeScore: 0, tokenAmount: tokens, availability }), [tokens, availability]);
  const boost = Math.max(0, est.dailyUsd - base.dailyUsd);
  const computePart = est.dailyUsd > 0 ? (base.dailyUsd / est.dailyUsd) * 100 : 100;
  const multPct = Math.min(1, Math.max(0, (est.multiplier - 1) / (cfg.maxMultiplier - 1))) * 100;
  const preset = PRESETS.find((p) => p.medianScore === score);
  const sim = useSim();

  if (!sim)
    return (
      <SimFallback
        title="No reward estimate yet."
        body={`The contributor pool is funded by creator fees paid to the protocol wallet and by inference sales. Nothing has been recorded yet, so the real pool today is $0 and any dollar figure here would be made up.${measured != null ? ` Your measured score of ${fmtInt(measured)} is real and recorded.` : " Measuring your GPU on /earn is real and takes about a minute."} The estimator can run against a modelled network, clearly labelled SIM.`}
      />
    );

  return (
    <div className="overflow-hidden rounded-[24px] bg-ink-2 ring-1 ring-chalk/[0.08]">
      <div className="grid lg:grid-cols-[1fr_1.05fr]">
        {/* Inputs */}
        <div className="space-y-8 p-6 md:p-9">
          <Field
            label="Your GPU"
            value={
              <span className="flex items-center gap-2">
                {fmtInt(score)} score <Prov p={score === measured ? "live" : "simulated"} />
              </span>
            }
          >
            <div className="mb-4">
              <MeasurePanel me={me} selected={score === measured} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {measured != null && (
                <Chip on={score === measured} onClick={() => setScore(measured)}>
                  <span className="text-signal">■</span> Measured
                </Chip>
              )}
              {PRESETS.map((p) => (
                <Chip key={p.id} on={preset?.id === p.id && score !== measured} onClick={() => setScore(p.medianScore)}>
                  {p.id === "OTHER_WEBGPU" ? "Integrated / other" : p.label.replace("MAX", "Max")}
                </Chip>
              ))}
            </div>
            <div className="mt-4">
              <Range label="Compute score" value={score} min={500} max={40_000} step={100} onChange={setScore} />
            </div>
            <p className="mt-2 font-mono text-[10.5px] text-chalk/35">Presets are network median scores <Prov p="simulated" /> · only the measured score is real</p>
          </Field>

          <Field label="Hours online per day" value={`${hours} h`}>
            <Range label="Hours online per day" value={hours} min={1} max={24} step={1} onChange={setHours} />
          </Field>

          <Field label="Token holdings" value={`${fmtInt(tokens)} BRAIN · ${fmtPct(Math.min(tokens / cfg.circulatingSupply, 1), 2)}`}>
            <div className="mb-4 flex flex-wrap gap-1.5">
              {TOKEN_STEPS.map((t) => (
                <Chip key={t} on={tokens === t} onClick={() => setTokens(t)}>
                  {t === 0 ? "None" : `${t / 1_000_000}M`}
                </Chip>
              ))}
            </div>
            <Range label="Token holdings" value={tokens} min={0} max={20_000_000} step={50_000} onChange={setTokens} />
          </Field>

          {!compact && (
            <div>
              <button type="button" onClick={() => setShowFormula((v) => !v)} className="font-mono text-[11.5px] text-chalk/50 hover:text-chalk">
                {showFormula ? "−" : "+"} How it&apos;s calculated
              </button>
              {showFormula && (
                <div className="mt-3 rounded-xl bg-ink p-4 font-mono text-[12px] leading-relaxed text-chalk/70">
                  <div className="text-chalk/40">// rewards/formula.ts</div>
                  <div>
                    effToken = max(normToken, <span className="text-signal">λ</span>·normCompute)
                  </div>
                  <div>base = √(normCompute · effToken)</div>
                  <div>
                    mult = min(base / (√λ·normCompute), <span className="text-signal">{cfg.maxMultiplier}</span>)
                  </div>
                  <div>score = √λ · normCompute · mult · quality</div>
                  <div className="mt-2 text-chalk/40">
                    λ={cfg.nonHolderBaseline} · token cap={fmtPct(cfg.tokenShareCap, 0)} of supply · node cap={fmtPct(cfg.maxNodeShareOfPool, 0)} of pool
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Output */}
        <div className="flex flex-col border-t border-chalk/[0.08] bg-[#1c1c1a] p-6 md:p-9 lg:border-l lg:border-t-0">
          <div className="flex items-center justify-between">
            <span className="label text-chalk/45">Estimated reward</span>
            <Prov p="estimated" />
          </div>
          <div className="mt-5 flex items-baseline gap-3">
            <motion.span key={Math.round(est.dailyUsd * 100)} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} className="num text-[64px] font-medium leading-none tracking-tight text-signal md:text-[84px]">
              {fmtUsdSmall(est.dailyUsd)}
            </motion.span>
            <span className="font-mono text-[13px] text-chalk/45">/ day</span>
          </div>
          <div className="mt-4 flex gap-8 font-mono text-[12.5px]">
            <span>
              <span className="text-chalk/40">7 days </span>
              <span className="num text-chalk">{fmtUsd(est.dailyUsd * 7)}</span>
            </span>
            <span>
              <span className="text-chalk/40">30 days </span>
              <span className="num text-chalk">{fmtUsd(est.dailyUsd * 30)}</span>
            </span>
          </div>

          <div className="mt-9">
            <div className="mb-2 flex justify-between font-mono text-[11px] text-chalk/45">
              <span>Where it comes from</span>
              <span>
                compute {fmtUsdSmall(base.dailyUsd)} · token boost +{fmtUsdSmall(boost)}
              </span>
            </div>
            <div className="flex h-3 gap-[3px] overflow-hidden rounded-full bg-chalk/[0.06]">
              <motion.span className="h-full rounded-l-full bg-chalk" animate={{ width: `${computePart}%` }} transition={{ type: "spring", stiffness: 200, damping: 30 }} />
              <motion.span className="h-full rounded-r-full bg-signal" animate={{ width: `${100 - computePart}%` }} transition={{ type: "spring", stiffness: 200, damping: 30 }} />
            </div>
          </div>

          <div className="mt-7">
            <div className="mb-2 flex justify-between font-mono text-[11px] text-chalk/45">
              <span>Token multiplier</span>
              <span className="text-chalk">{est.multiplier.toFixed(2)}× of {cfg.maxMultiplier}× max</span>
            </div>
            <div className="relative h-3 rounded-full bg-chalk/[0.06]">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} className="absolute top-1/2 h-1.5 w-px -translate-y-1/2 bg-chalk/15" style={{ left: `${(i + 1) * 10}%` }} />
              ))}
              <motion.span className="absolute inset-y-0 left-0 rounded-full bg-signal/70" animate={{ width: `${multPct}%` }} transition={{ type: "spring", stiffness: 200, damping: 30 }} />
            </div>
            <div className="mt-1.5 flex justify-between font-mono text-[10px] text-chalk/30">
              <span>1× no tokens</span>
              <span>{cfg.maxMultiplier}× cap</span>
            </div>
          </div>

          <dl className="mt-8 border-t border-chalk/10 font-mono text-[12px]">
            <div className="flex justify-between border-b border-chalk/10 py-2.5">
              <dt className="text-chalk/50">Same GPU, no tokens</dt>
              <dd>{fmtUsdSmall(base.dailyUsd)} / day</dd>
            </div>
            <div className="flex justify-between border-b border-chalk/10 py-2.5">
              <dt className="text-chalk/50">Same tokens, no GPU</dt>
              <dd className={cx(holdOnly.dailyUsd === 0 && "text-chalk/40")}>{fmtUsdSmall(holdOnly.dailyUsd)} · rewards require verified compute</dd>
            </div>
            <div className="flex justify-between py-2.5">
              <dt className="text-chalk/50">Contributor pool today</dt>
              <dd>
                {fmtUsd(est.contributorPoolUsd)} <Prov p="simulated" />
              </dd>
            </div>
          </dl>

          <p className="mt-auto pt-6 text-[12px] leading-relaxed text-chalk/40">
            Estimate using the production reward formula against a simulated network. Actual rewards depend on realized creator fees and inference sales, and on the verified
            compute of all other contributors. Not a guarantee of earnings.
          </p>
        </div>
      </div>
    </div>
  );
}
