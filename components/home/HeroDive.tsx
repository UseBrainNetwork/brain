"use client";

import { motion, useMotionValueEvent, useScroll, useTransform } from "motion/react";
import { useRef, useState } from "react";
import { Ticker } from "@/components/home/Ticker";
import { ComputeDie } from "@/components/network/ComputeDie";
import { Button } from "@/components/ui";
import { useReal } from "@/network/realtime/real";

/**
 * Pinned hero. Scrolling scrubs one camera move: the copy falls away, the die turns top-down,
 * an orange rim locks onto one node and the camera descends into it. Its black becomes the
 * next section, where the job that landed on that node is followed end to end.
 */
export function HeroDive() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress: p } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const [dark, setDark] = useState(false);
  useMotionValueEvent(p, "change", (v) => setDark(v > 0.6));
  const realNodes = useReal((r) => Object.keys(r.nodes).length);

  const copyOpacity = useTransform(p, [0, 0.16], [1, 0]);
  const copyY = useTransform(p, [0, 0.22], [0, -90]);
  const chromeOpacity = useTransform(p, [0, 0.08], [1, 0]);
  const tickerY = useTransform(p, [0, 0.1], [0, 44]);
  const caption = useTransform(p, [0.36, 0.44, 0.7, 0.78], [0, 1, 1, 0]);
  const black = useTransform(p, [0.84, 0.95], [0, 1]);
  const dof = useTransform(p, [0.12, 0.45, 0.8, 0.9], [0, 1, 1, 0]);
  const dot = useTransform(p, [0.9, 0.97], [0, 1]);
  const dotScale = useTransform(p, [0.9, 1], [0.4, 1]);

  return (
    <section ref={ref} className="relative h-[320vh]">
      <div data-theme={dark ? "dark" : "light"} className="surface-light sticky top-0 h-dvh overflow-hidden">
        <div className="absolute inset-0">
          <ComputeDie dive={ref} className="h-full w-full" />
        </div>

        {/* depth of field: edges defocus as the camera descends */}
        <motion.div
          aria-hidden
          style={{ opacity: dof }}
          className="pointer-events-none absolute inset-0 z-[5] backdrop-blur-[7px] [mask-image:radial-gradient(ellipse_at_center,transparent_30%,#000_78%)]"
        />
        <motion.div
          aria-hidden
          style={{ opacity: dof }}
          className="pointer-events-none absolute inset-0 z-[5] bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.45)_100%)]"
        />

        <motion.div style={{ opacity: copyOpacity, y: copyY }} className="pointer-events-none relative z-10 mx-auto max-w-[1600px] px-5 pt-[104px] md:px-10 lg:pt-[150px]">
          <div className="lg:max-w-[780px]">
            <div className="label mb-7 flex items-center gap-2.5 text-ink/60">
              <span className={realNodes > 0 ? "size-[7px] bg-ok" : "size-[7px] bg-ink/25"} />
              {realNodes > 0 ? `${realNodes} real node${realNodes === 1 ? "" : "s"} online` : "No real nodes online right now"} <span className="rounded-sm px-1 text-[9.5px] text-ok ring-1 ring-ok/40">REAL</span>
            </div>
            <h1 className="display text-[52px] sm:text-[84px] lg:text-[92px] xl:text-[104px]">
              Compute
              <br />
              from everywhere.
            </h1>
            <p className="mt-7 max-w-[460px] text-[16px] leading-[1.5] text-ink/75 md:mt-8 md:text-[19px]">
              BRAIN routes every request to the cheapest path that can run it, browser compute, cloud GPUs or external models, and attaches a receipt. Your computer can power it.
            </p>
            <div className="pointer-events-auto mt-7 flex flex-wrap gap-2.5 md:mt-8">
              <Button href="/chat" variant="primary" arrow>
                Use BRAIN
              </Button>
              <Button href="/earn" variant="secondary">
                Power BRAIN
              </Button>
            </div>
          </div>
        </motion.div>

        <motion.div
          style={{ opacity: chromeOpacity }}
          className="pointer-events-none absolute bottom-[68px] right-5 z-10 hidden flex-col items-end gap-1.5 font-mono text-[10.5px] text-ink/50 md:right-10 lg:flex"
        >
          <span className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="size-2 bg-signal" /> executing
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 bg-ok" /> verified / real node
            </span>
            <span>1 cell = 1 node</span>
          </span>
          <span>Scroll to trace one request through the network</span>
        </motion.div>

        <motion.div style={{ opacity: caption }} className="pointer-events-none absolute inset-x-0 bottom-[16%] z-10 flex justify-center">
          <div className="flex items-center gap-3 rounded-full bg-ink/90 px-4 py-2 font-mono text-[11.5px] text-chalk backdrop-blur">
            <span className="size-1.5 animate-pulse rounded-full bg-signal" />
            <span>JOB #918282 assigned</span>
            <span className="hidden text-chalk/40 sm:inline">→ one of 12,842 nodes</span>
            <span className="rounded-sm px-1 text-[9.5px] text-chalk/45 ring-1 ring-chalk/20">EXAMPLE</span>
          </div>
        </motion.div>

        <motion.div style={{ opacity: black }} className="pointer-events-none absolute inset-0 z-20 bg-ink" />
        <motion.div style={{ opacity: dot }} className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
          <motion.div style={{ scale: dotScale }} className="flex flex-col items-center gap-5">
            <span className="size-3 rounded-full bg-signal shadow-[0_0_0_6px_rgba(61,90,254,0.18),0_0_40px_rgba(61,90,254,0.6)]" />
            <span className="font-mono text-[11px] tracking-[0.08em] text-chalk/50">INSIDE NODE 8A21 · EXAMPLE JOB</span>
          </motion.div>
        </motion.div>

        <motion.div style={{ opacity: chromeOpacity, y: tickerY }} className="absolute inset-x-0 bottom-0 z-10">
          <Ticker />
        </motion.div>
      </div>
    </section>
  );
}
