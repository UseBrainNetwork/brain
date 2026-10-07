"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Prov } from "@/components/ui";
import { useNetwork } from "@/network/realtime/store";
import { useSim } from "@/network/realtime/mode";
import { contributorPoolToday, networkUnitsPerDay } from "@/rewards/simulate";
import { defaultRevenueSplit } from "@/rewards/config";
import { getRevenue } from "@/services/data";
import { cx, fmtCompact, fmtInt, fmtUsd } from "@/lib/format";

type StageId = "trading" | "revenue" | "compute" | "capacity" | "inference" | "buyback";

const inferenceToday = getRevenue().find((r) => r.period === "today")!.inferenceRevenueUsd;
const buybackShare = defaultRevenueSplit.inferenceRevenue.buyback;

const S = 640;
const CX = S / 2;
const CY = S / 2;
const R = 196;

const ring: { id: StageId; label: string; angle: number }[] = [
  { id: "revenue", label: "REVENUE", angle: -90 },
  { id: "compute", label: "COMPUTE", angle: 0 },
  { id: "capacity", label: "CAPACITY", angle: 90 },
  { id: "inference", label: "INFERENCE", angle: 180 },
];

const copy: Record<StageId, { title: string; body: string }> = {
  trading: { title: "Trading", body: "Pump.fun creator fees from token trading are claimed by the protocol wallet and moved to the payout wallet. A fixed SOL pool is paid out of it each epoch." },
  revenue: { title: "Revenue", body: "Creator fees and inference sales are allocated by published splits to contributors, token buyback, infrastructure and treasury." },
  compute: { title: "Compute", body: "Contributors run verifiable workloads. Only output that passes server-side verification is credited." },
  capacity: { title: "Capacity", body: "Each verified node adds schedulable memory and throughput, raising the volume of work the network can accept." },
  inference: { title: "Inference", body: "Developers consume that capacity through an OpenAI-compatible API. Sales pay contributors and fund token buybacks." },
  buyback: { title: "Buyback", body: `${Math.round(buybackShare * 100)}% of inference sales buy the token on market and burn it. Each buyback is a trade, so it pays creator fees back into the loop.` },
};

const polar = (deg: number, r = R) => {
  const a = (deg * Math.PI) / 180;
  // Rounded so server and client trig agree byte-for-byte during hydration.
  return { x: Math.round((CX + r * Math.cos(a)) * 100) / 100, y: Math.round((CY + r * Math.sin(a)) * 100) / 100 };
};

function arcPath(from: number, to: number, r = R) {
  const a = polar(from, r);
  const b = polar(to, r);
  return `M ${a.x} ${a.y} A ${r} ${r} 0 0 1 ${b.x} ${b.y}`;
}

const order: StageId[] = ["trading", "revenue", "compute", "capacity", "inference", "buyback"];

export function Flywheel({ className }: { className?: string }) {
  const [hover, setHover] = useState<StageId | null>(null);
  const [auto, setAuto] = useState<StageId>("trading");
  const active = hover ?? auto;
  const m = useNetwork((s) => s.metrics);
  const sim = useSim();

  useEffect(() => {
    if (hover) return;
    const t = setInterval(() => setAuto((a) => order[(order.indexOf(a) + 1) % order.length]), 3200);
    return () => clearInterval(t);
  }, [hover]);

  const metric: Record<StageId, string> = {
    trading: `${fmtUsd(m.creatorRewardsTodayUsd)} creator rewards today`,
    revenue: `${fmtUsd(contributorPoolToday())} to contributor pool today`,
    compute: `${fmtCompact(networkUnitsPerDay(), 1)} verified units / day`,
    capacity: `${fmtInt(m.gpusOnline)} GPUs · ${m.availableMemoryTb.toFixed(1)} TB`,
    inference: `${fmtCompact(m.inferencesToday, 2)} inferences today`,
    buyback: `${fmtUsd(inferenceToday * buybackShare)} to buybacks today`,
  };

  const segIndex = ring.findIndex((r) => r.id === active);
  const tradingIn = polar(-150, R + 120);
  const tradingTo = polar(-100, R);
  const buybackAt = polar(150, R + 120);
  const buybackFrom = polar(172, R);
  const loopCtl = polar(180, R + 270);

  return (
    <div className={cx("mx-auto w-full max-w-[640px]", className)}>
      <div className="relative">
      <svg viewBox={`-60 -60 ${S + 120} ${S + 120}`} className="block w-full overflow-visible">
        <defs>
          <path id="fw-ring" d={`M ${CX} ${CY - R} A ${R} ${R} 0 1 1 ${CX - 0.01} ${CY - R}`} />
          <path id="fw-out" d={`M ${buybackFrom.x} ${buybackFrom.y} Q ${polar(160, R + 30).x} ${polar(160, R + 30).y} ${buybackAt.x} ${buybackAt.y}`} />
          <path id="fw-loop" d={`M ${buybackAt.x} ${buybackAt.y - 18} Q ${loopCtl.x} ${loopCtl.y} ${tradingIn.x} ${tradingIn.y + 18}`} />
          <path id="fw-in" d={`M ${tradingIn.x} ${tradingIn.y} Q ${polar(-125, R + 30).x} ${polar(-125, R + 30).y} ${tradingTo.x} ${tradingTo.y}`} />
        </defs>

        {/* Dial ticks */}
        {Array.from({ length: 120 }, (_, i) => {
          const a = i * 3;
          const major = i % 10 === 0;
          const p1 = polar(a, R + 26);
          const p2 = polar(a, R + (major ? 40 : 33));
          return <line key={i} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="currentColor" strokeOpacity={major ? 0.4 : 0.16} strokeWidth={major ? 1.4 : 1} />;
        })}
        <circle cx={CX} cy={CY} r={R + 22} fill="none" stroke="currentColor" strokeOpacity="0.08" />
        <circle cx={CX} cy={CY} r={R - 58} fill="none" stroke="currentColor" strokeOpacity="0.08" strokeDasharray="2 5" />

        {/* Base ring */}
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="currentColor" strokeOpacity="0.14" strokeWidth="10" />
        {/* Active segment: from the active stage to the next */}
        {segIndex >= 0 && (
          <motion.path
            key={active}
            d={arcPath(ring[segIndex].angle + 6, ring[segIndex].angle + 84)}
            fill="none"
            stroke="var(--color-signal)"
            strokeWidth="10"
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.9, ease: [0.3, 0.7, 0.2, 1] }}
          />
        )}
        {/* Flow */}
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="1 13" className="[animation:fw-dash_2.4s_linear_infinite]" />
        {Array.from({ length: 6 }, (_, i) => (
          <circle key={i} r="4" fill="var(--color-signal)">
            <animateMotion dur="9s" repeatCount="indefinite" begin={`${-i * 1.5}s`}>
              <mpath href="#fw-ring" />
            </animateMotion>
          </circle>
        ))}

        {/* Trading input */}
        <use href="#fw-in" fill="none" stroke={active === "trading" ? "var(--color-signal)" : "currentColor"} strokeOpacity={active === "trading" ? 1 : 0.3} strokeWidth="2" strokeDasharray="4 6" />
        {Array.from({ length: 3 }, (_, i) => (
          <circle key={i} r="3.5" fill="var(--color-signal)">
            <animateMotion dur="2.4s" repeatCount="indefinite" begin={`${-i * 0.8}s`}>
              <mpath href="#fw-in" />
            </animateMotion>
          </circle>
        ))}

        {/* Buyback output, and the buyback trade feeding creator fees */}
        <use href="#fw-out" fill="none" stroke={active === "buyback" ? "var(--color-signal)" : "currentColor"} strokeOpacity={active === "buyback" ? 1 : 0.3} strokeWidth="2" strokeDasharray="4 6" />
        <use href="#fw-loop" fill="none" stroke={active === "buyback" || active === "trading" ? "var(--color-signal)" : "currentColor"} strokeOpacity={active === "buyback" || active === "trading" ? 0.7 : 0.18} strokeWidth="1.5" strokeDasharray="2 6" />
        {(["fw-out", "fw-loop"] as const).map((id) =>
          Array.from({ length: 3 }, (_, i) => (
            <circle key={id + i} r={id === "fw-out" ? 3.5 : 2.5} fill="var(--color-signal)" fillOpacity={id === "fw-out" ? 1 : 0.7}>
              <animateMotion dur={id === "fw-out" ? "2.4s" : "3.6s"} repeatCount="indefinite" begin={`${-i * (id === "fw-out" ? 0.8 : 1.2)}s`}>
                <mpath href={`#${id}`} />
              </animateMotion>
            </circle>
          )),
        )}

        {/* Stage nodes */}
        {ring.map((r) => {
          const p = polar(r.angle);
          const on = active === r.id;
          return (
            <g key={r.id} onMouseEnter={() => setHover(r.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(r.id)} onBlur={() => setHover(null)} tabIndex={0} className="cursor-pointer outline-none">
              <circle cx={p.x} cy={p.y} r="30" fill="transparent" />
              <circle cx={p.x} cy={p.y} r={on ? 15 : 11} fill={on ? "var(--color-signal)" : "var(--color-ink)"} stroke="currentColor" strokeOpacity={on ? 0 : 0.5} strokeWidth="1.5" className="transition-all duration-300" />
              <circle cx={p.x} cy={p.y} r="4" fill={on ? "#fff" : "currentColor"} fillOpacity={on ? 1 : 0.6} />
              <text
                x={polar(r.angle, R + 62).x}
                y={polar(r.angle, R + 62).y + 4}
                textAnchor={r.angle === 0 ? "start" : r.angle === 180 ? "end" : "middle"}
                className="font-mono"
                fontSize="13"
                letterSpacing="1.2"
                fill="currentColor"
                fillOpacity={on ? 1 : 0.55}
              >
                {r.label}
              </text>
            </g>
          );
        })}
        <g onMouseEnter={() => setHover("trading")} onMouseLeave={() => setHover(null)} tabIndex={0} className="cursor-pointer outline-none">
          <rect x={tradingIn.x - 54} y={tradingIn.y - 18} width="108" height="36" rx="18" fill={active === "trading" ? "var(--color-signal)" : "transparent"} stroke="currentColor" strokeOpacity={active === "trading" ? 0 : 0.4} />
          <text x={tradingIn.x} y={tradingIn.y + 4.5} textAnchor="middle" className="font-mono" fontSize="13" letterSpacing="1.2" fill={active === "trading" ? "#fff" : "currentColor"}>
            TRADING
          </text>
        </g>
        <g onMouseEnter={() => setHover("buyback")} onMouseLeave={() => setHover(null)} tabIndex={0} className="cursor-pointer outline-none">
          <rect x={buybackAt.x - 54} y={buybackAt.y - 18} width="108" height="36" rx="18" fill={active === "buyback" ? "var(--color-signal)" : "var(--color-ink)"} stroke="currentColor" strokeOpacity={active === "buyback" ? 0 : 0.4} />
          <text x={buybackAt.x} y={buybackAt.y + 4.5} textAnchor="middle" className="font-mono" fontSize="13" letterSpacing="1.2" fill={active === "buyback" ? "#fff" : "currentColor"}>
            BUYBACK
          </text>
        </g>
      </svg>

      {/* Center readout */}
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="w-[46%] text-center">
          <AnimatePresence mode="wait">
            <motion.div key={active} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }}>
              <div className="label text-signal">{String(order.indexOf(active) + 1).padStart(2, "0")} · {copy[active].title}</div>
              <p className="mt-3 hidden text-[14px] leading-snug opacity-80 sm:block md:text-[15px]">{copy[active].body}</p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 font-mono text-[10px] opacity-60 sm:text-[11px]">
                {sim ? <>{metric[active]} <Prov p="simulated" /></> : <>no real figures yet <Prov p="live" /></>}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      </div>
      <p className="mt-2 text-center text-[14px] leading-snug opacity-75 sm:hidden">{copy[active].body}</p>
      <style>{`@keyframes fw-dash { to { stroke-dashoffset: -28; } }`}</style>
    </div>
  );
}
