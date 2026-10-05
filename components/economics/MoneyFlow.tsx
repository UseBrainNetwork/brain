"use client";

import { useState } from "react";
import { Prov } from "@/components/ui";
import { defaultRevenueSplit } from "@/rewards/config";
import { useNetwork } from "@/network/realtime/store";
import { useSim } from "@/network/realtime/mode";
import { getRevenue } from "@/services/data";
import { cx, fmtUsd } from "@/lib/format";

const today = getRevenue().find((r) => r.period === "today")!;

const W = 1200;
const H = 440;
const PAD_X = 210;
const BAR = 14;
const GAP = 34;

type Dest = "contributors" | "buyback" | "infrastructure" | "treasury";
const DESTS: { id: Dest; label: string; fill: string; text: string }[] = [
  { id: "contributors", label: "GPU contributors", fill: "var(--color-signal)", text: "text-signal" },
  { id: "buyback", label: "Token buyback", fill: "rgba(61,90,254,0.5)", text: "text-signal/70" },
  { id: "infrastructure", label: "Network infrastructure", fill: "rgba(230,233,238,0.55)", text: "text-chalk/70" },
  { id: "treasury", label: "Treasury", fill: "rgba(230,233,238,0.28)", text: "text-chalk/50" },
];

function stack(values: number[], scale: number) {
  const total = values.reduce((a, b) => a + b, 0) * scale + GAP * (values.length - 1);
  let y = (H - total) / 2;
  return values.map((v) => {
    const h = v * scale;
    const r = { y, h };
    y += h + GAP;
    return r;
  });
}

/** Today's revenue as a Sankey: ribbon widths are dollars, splits come from rewards/config.ts. */
export function MoneyFlow({ className }: { className?: string }) {
  const sim = useSim();
  if (!sim) return null;
  return <MoneyFlowSim className={className} />;
}

function MoneyFlowSim({ className }: { className?: string }) {
  const creator = useNetwork((s) => s.metrics.creatorRewardsTodayUsd);
  const [hover, setHover] = useState<Dest | null>(null);

  const sources = [
    { id: "creator", label: "Creator fees", sub: "Pump.fun trading", amt: creator, split: defaultRevenueSplit.creatorRewards },
    { id: "inference", label: "Inference sales", sub: "OpenAI-compatible API", amt: today.inferenceRevenueUsd, split: defaultRevenueSplit.inferenceRevenue },
  ];
  const total = sources.reduce((s, x) => s + x.amt, 0);
  const scale = (H - 60 - GAP * 2) / total;
  const destAmt = DESTS.map((d) => sources.reduce((s, x) => s + x.amt * x.split[d.id], 0));
  const srcBox = stack(sources.map((s) => s.amt), scale);
  const dstBox = stack(destAmt, scale);

  const x0 = PAD_X + BAR;
  const x1 = W - PAD_X - BAR;
  const xm = (x0 + x1) / 2;
  const srcCursor = srcBox.map((b) => b.y);
  const dstCursor = dstBox.map((b) => b.y);

  const ribbons = sources.flatMap((s, si) =>
    DESTS.flatMap((d, di) => {
      if (!s.split[d.id]) return [];
      const h = s.amt * s.split[d.id] * scale;
      const a = srcCursor[si];
      const b = dstCursor[di];
      srcCursor[si] += h;
      dstCursor[di] += h;
      const band = `M ${x0} ${a} C ${xm} ${a}, ${xm} ${b}, ${x1} ${b} L ${x1} ${b + h} C ${xm} ${b + h}, ${xm} ${a + h}, ${x0} ${a + h} Z`;
      const mid = `M ${x0} ${a + h / 2} C ${xm} ${a + h / 2}, ${xm} ${b + h / 2}, ${x1} ${b + h / 2}`;
      return [{ key: `${s.id}-${d.id}`, d, h, band, mid, n: Math.max(2, Math.round(h / 4.5)) }];
    }),
  );

  return (
    <div className={cx("relative", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Today's revenue routed to contributors, token buyback, infrastructure and treasury">
        <defs>
          {DESTS.map((d) => (
            <linearGradient key={d.id} id={`mf-g-${d.id}`} x1={x0} x2={x1} y1="0" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#e6e9ee" stopOpacity="0.1" />
              <stop offset="1" stopColor={d.fill} stopOpacity={d.id === "contributors" ? 0.62 : 0.3} />
            </linearGradient>
          ))}
        </defs>
        {ribbons.map((r) => {
          const dim = hover && hover !== r.d.id;
          return (
            <g key={r.key} onMouseEnter={() => setHover(r.d.id)} onMouseLeave={() => setHover(null)}>
              <path d={r.band} fill={`url(#mf-g-${r.d.id})`} opacity={dim ? 0.15 : 1} className="transition-opacity duration-300" />
              <path id={`mf-${r.key}`} d={r.mid} fill="none" />
              {Array.from({ length: r.n }, (_, i) => (
                <circle key={i} r={r.d.id === "contributors" ? 2.4 : 1.8} fill={r.d.id === "contributors" ? "#fff" : "rgba(230,233,238,0.8)"} opacity={dim ? 0.1 : 0.9}>
                  <animateMotion dur={`${3.2 + (i % 3) * 0.5}s`} repeatCount="indefinite" begin={`${(-i * 3.6) / r.n}s`}>
                    <mpath href={`#mf-${r.key}`} />
                  </animateMotion>
                  <animate attributeName="cy" values={`${-r.h * 0.38};${r.h * 0.38};${-r.h * 0.38}`} dur={`${2.1 + (i % 5) * 0.37}s`} repeatCount="indefinite" />
                </circle>
              ))}
            </g>
          );
        })}

        {sources.map((s, i) => (
          <g key={s.id}>
            <rect x={PAD_X} y={srcBox[i].y} width={BAR} height={srcBox[i].h} rx={3} fill="#e6e9ee" />
            <text x={PAD_X - 18} y={srcBox[i].y + srcBox[i].h / 2 - 12} textAnchor="end" className="font-mono" fontSize="12" letterSpacing="1" fill="rgba(230,233,238,0.5)">
              {s.label.toUpperCase()}
            </text>
            <text x={PAD_X - 18} y={srcBox[i].y + srcBox[i].h / 2 + 14} textAnchor="end" fontSize="24" fontWeight="500" fill="#e6e9ee" style={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtUsd(s.amt)}
            </text>
            <text x={PAD_X - 18} y={srcBox[i].y + srcBox[i].h / 2 + 34} textAnchor="end" fontSize="12" fill="rgba(230,233,238,0.4)">
              {s.sub}
            </text>
          </g>
        ))}

        {DESTS.map((d, i) => (
          <g key={d.id} onMouseEnter={() => setHover(d.id)} onMouseLeave={() => setHover(null)} className="cursor-default">
            <rect x={x1} y={dstBox[i].y} width={BAR} height={Math.max(2, dstBox[i].h)} rx={3} fill={d.fill} fillOpacity={d.id === "contributors" ? 1 : 0.9} />
            <text x={x1 + BAR + 18} y={dstBox[i].y + dstBox[i].h / 2 - 8} className="font-mono" fontSize="12" letterSpacing="1" fill={d.id === "contributors" ? "var(--color-signal)" : "rgba(230,233,238,0.5)"}>
              {d.label.toUpperCase()}
            </text>
            <text x={x1 + BAR + 18} y={dstBox[i].y + dstBox[i].h / 2 + 18} fontSize="24" fontWeight="500" fill="#e6e9ee" style={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtUsd(destAmt[i])}
            </text>
          </g>
        ))}
      </svg>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 font-mono text-[11px] text-chalk/40">
        <span className="flex items-center gap-2">
          Ribbon width = dollars today <Prov p="simulated" />
        </span>
        <span>
          {sources.map((s) => `${s.label}: ${DESTS.filter((d) => s.split[d.id]).map((d) => `${Math.round(s.split[d.id] * 100)}% ${d.label.toLowerCase()}`).join(", ")}`).join(" · ")}
        </span>
      </div>
    </div>
  );
}
