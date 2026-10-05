"use client";

import { motion } from "motion/react";
import { Prov } from "@/components/ui";
import { defaultRevenueSplit } from "@/rewards/config";
import { getBaselineMetrics, getRevenue } from "@/services/data";
import { fmtInt, fmtUsd } from "@/lib/format";

const today = getRevenue().find((r) => r.period === "today")!;
const m = getBaselineMetrics();
const cr = defaultRevenueSplit.creatorRewards;
const inf = defaultRevenueSplit.inferenceRevenue;

const STATIONS = [
  { name: "Trading", value: "Pump.fun", sub: "Every trade of the token pays a creator fee." },
  { name: "Creator rewards", value: fmtUsd(today.creatorRewardsUsd), sub: "Fees claimed by the protocol wallet." },
  { name: "Compute reward pool", value: fmtUsd(today.creatorRewardsUsd * cr.contributors), sub: `${Math.round(cr.contributors * 100)}% of creator rewards, per epoch.` },
  { name: "GPU contributors", value: fmtUsd(today.computePayoutsUsd), sub: "Paid by verified compute × token weight." },
  { name: "Network capacity", value: fmtInt(m.gpusOnline), sub: "Nodes online. Better pay keeps more GPUs online." },
  { name: "Inference sales", value: fmtUsd(today.inferenceRevenueUsd), sub: "Developers pay for API usage." },
  { name: "Token buyback", value: fmtUsd(today.inferenceRevenueUsd * inf.buyback), sub: `${Math.round(inf.buyback * 100)}% of sales buy the token on market and burn it. ${Math.round(inf.contributors * 100)}% goes to contributors.` },
];

/** The value chain as a rail. A pulse runs end to end; each station lights as it passes. */
export function FlowChain() {
  const n = STATIONS.length;
  const dur = 7;
  return (
    <div className="relative">
      <div className="absolute left-[15px] top-4 bottom-4 w-px bg-chalk/15 lg:left-0 lg:right-0 lg:top-[15px] lg:bottom-auto lg:h-px lg:w-auto" />
      <motion.div
        className="absolute left-[12px] top-4 hidden size-[7px] rounded-full bg-signal shadow-[0_0_0_4px_rgba(61,90,254,0.18)] lg:block"
        style={{ top: 12 }}
        animate={{ left: ["0%", "100%"] }}
        transition={{ duration: dur, repeat: Infinity, ease: "linear" }}
      />
      <ol className="grid gap-8 lg:grid-cols-7 lg:gap-4">
        {STATIONS.map((s, i) => (
          <li key={s.name} className="relative pl-12 lg:pl-0 lg:pt-12">
            <motion.span
              className="absolute left-0 top-0 grid size-[31px] place-items-center rounded-full bg-ink font-mono text-[10px] font-semibold ring-1 ring-chalk/25"
              animate={{ backgroundColor: ["#0b0d11", "#3d5afe", "#0b0d11"], color: ["#e6e9ee", "#ffffff", "#e6e9ee"] }}
              transition={{ duration: dur, times: [Math.max(0, i / (n - 1) - 0.04), i / (n - 1), Math.min(1, i / (n - 1) + 0.1)], repeat: Infinity, ease: "linear" }}
            >
              {String(i + 1).padStart(2, "0")}
            </motion.span>
            <div className="label text-chalk/50">{s.name}</div>
            <div className="num mt-2 flex items-center gap-2 text-[22px] font-medium xl:text-[26px]">
              {s.value} {i > 0 && <Prov p="simulated" />}
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-chalk/50">{s.sub}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
