"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { cx } from "@/lib/format";
import { useSim } from "@/network/realtime/mode";

interface Frame {
  k: string;
  top: string;
  main: string;
  sub: string;
  tone: "chalk" | "signal" | "ok";
}

/** The join sequence as it really runs. Nothing here is a network figure or a dollar amount. */
const realFrames: Frame[] = [
  { k: "detect", top: "DEVICE DETECTED", main: "WebGPU · READY", sub: "adapter: apple · metal-3", tone: "chalk" },
  { k: "bench", top: "BENCHMARKING", main: "▮▮▮▮▮▮▮▯▯▯", sub: "server challenge · mix_u32", tone: "chalk" },
  { k: "join", top: "NODE 9F81 JOINED", main: "+18,482 COMPUTE", sub: "standby → online", tone: "signal" },
  { k: "recv", top: "FIRST JOB RECEIVED…", main: "#5000001", sub: "tensor/matmul-u32 256³", tone: "chalk" },
  { k: "comp", top: "COMPUTING…", main: "16.7M MACs", sub: "WGSL · 1024 workgroups", tone: "signal" },
  { k: "ok", top: "VERIFIED.", main: "6/6 ROWS MATCH", sub: "secret rows recomputed on server", tone: "ok" },
];

/** Demo mode: same sequence with simulated network totals and an illustrative reward. */
const simFrames: Frame[] = realFrames.map((f) =>
  f.k === "join" ? { ...f, sub: "12,842 → 12,843 GPUs · SIM" } : f.k === "ok" ? { ...f, main: "+$0.0032", sub: "6/6 secret rows match · est. SIM" } : f,
);

/** Physical-feeling node: a plate with a status display that plays the join sequence. */
export function NodePlate({ className }: { className?: string }) {
  const [i, setI] = useState(0);
  const frames = useSim() ? simFrames : realFrames;
  useEffect(() => {
    const t = setTimeout(() => setI((x) => (x + 1) % frames.length), i === frames.length - 1 ? 3200 : 1700);
    return () => clearTimeout(t);
  }, [i]);
  const f = frames[i];

  return (
    <div className={cx("relative", className)}>
      <div className="relative mx-auto aspect-square w-full max-w-[460px] rounded-[44px] bg-gradient-to-b from-[#fbfaf7] to-[#e9e7e1] p-[9%] shadow-[0_2px_0_rgba(255,255,255,0.9)_inset,0_-2px_0_rgba(0,0,0,0.06)_inset,0_50px_80px_-30px_rgba(17,17,16,0.45),0_14px_24px_-12px_rgba(17,17,16,0.25)]">
        <Screw className="left-[7%] top-[7%]" />
        <Screw className="right-[7%] top-[7%]" r={40} />
        <Screw className="bottom-[7%] left-[7%]" r={-30} />
        <Screw className="bottom-[7%] right-[7%]" r={80} />
        <div className="absolute right-[18%] top-[9.5%] flex items-center gap-1.5">
          <span className={cx("size-[7px] rounded-full transition-colors duration-300", f.tone === "ok" ? "bg-ok shadow-[0_0_10px_#2fbf71]" : f.tone === "signal" ? "bg-signal shadow-[0_0_10px_#3d5afe]" : "bg-[#c9ced6]")} />
        </div>
        <div className="absolute left-[18%] top-[8.5%] font-mono text-[9px] tracking-[0.12em] text-[#a19e95]">BRAIN · NODE</div>

        <div className="relative mt-[6%] flex h-full flex-col overflow-hidden rounded-[22px] bg-[#0d0d0c] p-[7%] shadow-[0_0_0_6px_#d9d6ce,0_0_0_7px_#c9c6bd,inset_0_10px_30px_rgba(0,0,0,0.6)]">
          <div className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:repeating-linear-gradient(0deg,#fff_0_1px,transparent_1px_3px)]" />
          <div className="flex items-center justify-between font-mono text-[10px] text-chalk/35">
            <span>STATUS</span>
            <span>{String(i + 1).padStart(2, "0")}/06</span>
          </div>
          <div className="flex flex-1 flex-col justify-center">
            <AnimatePresence mode="wait">
              <motion.div key={f.k} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}>
                <div className={cx("font-mono text-[12px] tracking-[0.06em]", f.tone === "ok" ? "text-ok" : f.tone === "signal" ? "text-signal" : "text-chalk/60")}>{f.top}</div>
                <div className={cx("num mt-2 text-[30px] font-semibold leading-none sm:text-[38px]", f.tone === "ok" ? "text-chalk" : "text-chalk")}>{f.main}</div>
                <div className="mt-3 font-mono text-[11px] text-chalk/40">{f.sub}</div>
              </motion.div>
            </AnimatePresence>
          </div>
          <div className="flex gap-1">
            {frames.map((_, k) => (
              <span key={k} className={cx("h-[3px] flex-1 rounded-full transition-colors duration-300", k <= i ? "bg-signal" : "bg-chalk/10")} />
            ))}
          </div>
        </div>
      </div>
      <div className="mt-4 text-center font-mono text-[11px] text-fog-2">preview of the join sequence · values illustrative</div>
    </div>
  );
}

function Screw({ className, r = 0 }: { className?: string; r?: number }) {
  return (
    <span className={cx("absolute grid size-[18px] place-items-center rounded-full bg-gradient-to-b from-[#dde0e6] to-[#aab1bb] shadow-[inset_0_1px_1px_rgba(255,255,255,0.7)]", className)}>
      <span className="block h-[2px] w-[11px] rounded bg-[#6f6c64]" style={{ transform: `rotate(${r}deg)` }} />
    </span>
  );
}
