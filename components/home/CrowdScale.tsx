"use client";

import { motion, useMotionValueEvent, useScroll, useTransform } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Container, Odometer, Prov } from "@/components/ui";
import { networkStore, useNetwork } from "@/network/realtime/store";
import { useSim } from "@/network/realtime/mode";
import { getDeviceClasses } from "@/services/data";
import { cx, fmtInt } from "@/lib/format";

/** H100 SXM ships with 80 GB of HBM3: the reference point the scene starts from. */
const DC_GPU_MEMORY_GB = 80;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const STEPS = [
  { k: "01", title: "One datacenter GPU.", body: "The usual way to serve AI: a single 80 GB accelerator in a rack, rented by the hour." },
  { k: "02", title: "Or the crowd.", body: "Thousands of ordinary GPUs in laptops and desktops, each contributing what WebGPU lets it allocate." },
  { k: "03", title: "Pooled behind one API.", body: "Sorted by device class and scheduled as one network. Developers see a single OpenAI-compatible endpoint." },
];

/**
 * Pinned scene. 12,842 points start packed as one slab, burst into a field of devices, then
 * settle into the network floorplan by device class. Scroll position is the timeline.
 */
export function CrowdScale() {
  const ref = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const prog = useRef(0);
  const { scrollYProgress: p } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const [step, setStep] = useState(0);
  const [t, setT] = useState(0);
  useMotionValueEvent(p, "change", (v) => {
    prog.current = v;
    setT(v);
    setStep(v < 0.3 ? 0 : v < 0.66 ? 1 : 2);
  });
  const m = useNetwork((s) => s.metrics);
  const sim = useSim();
  const grow = smooth(0.18, 0.55, t);
  const gpus = Math.round(1 + (m.gpusOnline - 1) * grow);
  const memGb = DC_GPU_MEMORY_GB + (m.availableMemoryTb * 1000 - DC_GPU_MEMORY_GB) * grow;
  const memText = memGb < 1000 ? `${Math.round(memGb)} GB` : `${(memGb / 1000).toFixed(1)} TB`;
  const legend = useTransform(p, [0.66, 0.78], [0, 1]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const classes = getDeviceClasses();
    const N = classes.reduce((s, d) => s + d.nodes, 0);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const delay = new Float32Array(N);
    const sx = new Float32Array(N);
    const sy = new Float32Array(N);
    const tone = new Float32Array(N);
    const cls = new Uint8Array(N);
    let k = 0;
    classes.forEach((d, ci) => {
      for (let i = 0; i < d.nodes; i++, k++) {
        cls[k] = ci;
        delay[k] = rnd() * 0.35;
        sx[k] = rnd();
        sy[k] = rnd();
        tone[k] = 0.35 + rnd() * 0.4;
      }
    });
    const ax = new Float32Array(N);
    const ay = new Float32Array(N);
    const bx = new Float32Array(N);
    const by = new Float32Array(N);
    const cx2 = new Float32Array(N);
    const cy2 = new Float32Array(N);
    let w = 0;
    let h = 0;
    let labels: { x: number; y: number; text: string; max: number }[] = [];
    let plates: { x: number; y: number; w: number; h: number }[] = [];
    let slab = { x: 0, y: 0, w: 0, h: 0 };

    const layout = () => {
      const dpr = Math.min(2, devicePixelRatio);
      w = c.clientWidth;
      h = c.clientHeight;
      c.width = w * dpr;
      c.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const wide = w > 1000;
      const R = wide ? { x: w * 0.44, y: h * 0.16, w: w * 0.52, h: h * 0.72 } : { x: w * 0.05, y: h * 0.6, w: w * 0.9, h: h * 0.36 };

      // A: one slab
      const sw = Math.min(R.w * 0.34, R.h * 0.5);
      const sh = sw * 1.32;
      slab = { x: R.x + (R.w - sw) / 2, y: R.y + (R.h - sh) / 2, w: sw, h: sh };
      const cols = Math.ceil(Math.sqrt((N * sw) / sh));
      const rows = Math.ceil(N / cols);
      for (let i = 0; i < N; i++) {
        ax[i] = slab.x + ((i % cols) + 0.5) * (sw / cols);
        ay[i] = slab.y + (Math.floor(i / cols) + 0.5) * (sh / rows);
      }
      // B: field
      for (let i = 0; i < N; i++) {
        bx[i] = R.x - R.w * 0.04 + sx[i] * R.w * 1.08;
        by[i] = R.y - R.h * 0.06 + sy[i] * R.h * 1.12;
      }
      // C: floorplan, two rows of three districts sized by node count
      labels = [];
      plates = [];
      const order = [
        [0, 1, 2],
        [3, 4, 5],
      ];
      const gap = Math.max(10, R.w * 0.02);
      const rowTotals = order.map((r) => r.reduce((s, ci) => s + classes[ci].nodes, 0));
      const all = rowTotals[0] + rowTotals[1];
      let y0 = R.y;
      const offs = new Int32Array(classes.length);
      let acc = 0;
      classes.forEach((d, ci) => {
        offs[ci] = acc;
        acc += d.nodes;
      });
      order.forEach((r, ri) => {
        const rh = (R.h - gap) * (rowTotals[ri] / all);
        let x0 = R.x;
        for (const ci of r) {
          const d = classes[ci];
          const dw = (R.w - gap * (r.length - 1)) * (d.nodes / rowTotals[ri]);
          const pitch = Math.sqrt(((dw - 8) * (rh - 28)) / d.nodes);
          const dc = Math.max(1, Math.floor(dw / pitch));
          for (let i = 0; i < d.nodes; i++) {
            const idx = offs[ci] + i;
            cx2[idx] = x0 + ((i % dc) + 0.5) * pitch;
            cy2[idx] = y0 + 22 + (Math.floor(i / dc) + 0.5) * pitch;
          }
          labels.push({ x: x0 + 8, y: y0 + 13, text: `${d.label} · ${fmtInt(d.nodes)}`, max: dw - 12 });
          plates.push({ x: x0 - 4, y: y0, w: dw + 8, h: rh });
          x0 += dw + gap;
        }
        y0 += rh + gap;
      });
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(c);

    const hot = new Float32Array(N);
    let raf = 0;
    let last = performance.now();
    let acc2 = 0;
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(c);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible || !w) return;
      const v = prog.current;
      const ab = v;
      const bc = smooth(0.55, 0.9, v);
      // activity: points flash at the simulated request rate once the crowd exists
      if (!reduced && v > 0.25) {
        acc2 += dt * networkStore.getSnapshot().metrics.requestsPerSec * 0.5;
        while (acc2 >= 1) {
          acc2 -= 1;
          hot[(Math.random() * N) | 0] = 1;
        }
      }
      ctx.clearRect(0, 0, w, h);

      // slab chrome fades as it breaks
      const slabA = 1 - smooth(0.16, 0.26, v);
      if (slabA > 0.01) {
        ctx.globalAlpha = slabA;
        ctx.fillStyle = "#1b1e25";
        ctx.strokeStyle = "rgba(230,233,238,0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(slab.x - 14, slab.y - 14, slab.w + 28, slab.h + 28, 16);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "rgba(230,233,238,0.55)";
        ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillText("1 × DATACENTER GPU · 80 GB", slab.x - 14, slab.y - 26);
        ctx.globalAlpha = 1;
      }

      if (bc > 0.3) {
        const pa = smooth(0.3, 0.8, bc);
        for (const pl of plates) {
          ctx.fillStyle = `rgba(230,233,238,${0.035 * pa})`;
          ctx.strokeStyle = `rgba(230,233,238,${0.12 * pa})`;
          ctx.beginPath();
          ctx.roundRect(pl.x, pl.y, pl.w, pl.h, 8);
          ctx.fill();
          ctx.stroke();
        }
      }

      const sz = 1.25 + (1 - smooth(0.2, 0.4, v)) * 0.6;
      for (let i = 0; i < N; i++) {
        const u = smooth(0.18 + delay[i] * 0.5, 0.42 + delay[i] * 0.5, ab);
        // burst: points overshoot outward from the slab center before drifting to the field
        const burst = Math.sin(u * Math.PI) * 0.18;
        let x = ax[i] + (bx[i] - ax[i]) * u + (bx[i] - (slab.x + slab.w / 2)) * burst;
        let y = ay[i] + (by[i] - ay[i]) * u + (by[i] - (slab.y + slab.h / 2)) * burst;
        const e = smooth(delay[i] * 0.4, 0.6 + delay[i] * 0.4, bc);
        x += (cx2[i] - x) * e;
        y += (cy2[i] - y) * e;
        const hh = hot[i];
        if (hh > 0.02) {
          hot[i] = hh * Math.exp(-dt * 3.5);
          const r2 = sz * (1.2 + hh * 1.6);
          ctx.fillStyle = `rgba(61,90,254,${0.12 * hh})`;
          ctx.fillRect(x - r2 * 2, y - r2 * 2, r2 * 4, r2 * 4);
          ctx.fillStyle = `rgba(255,${90 + (1 - hh) * 60},31,${0.5 + hh * 0.5})`;
          ctx.fillRect(x - r2 / 2, y - r2 / 2, r2, r2);
        } else {
          const a = slabA > 0.5 ? 0.85 : tone[i];
          ctx.fillStyle = `rgba(230,233,238,${a})`;
          ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
        }
      }

      if (bc > 0.85) {
        ctx.globalAlpha = smooth(0.85, 1, bc);
        ctx.fillStyle = "rgba(230,233,238,0.55)";
        ctx.font = "10.5px ui-monospace, SFMono-Regular, Menlo, monospace";
        for (const l of labels) {
          if (ctx.measureText(l.text).width <= l.max) ctx.fillText(l.text, l.x, l.y);
          else if (ctx.measureText(l.text.split(" · ")[0]).width <= l.max) ctx.fillText(l.text.split(" · ")[0], l.x, l.y);
        }
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  return (
    <section ref={ref} data-theme="dark" className="surface-dark relative h-[320vh]">
      <div className="sticky top-0 h-dvh overflow-hidden">
        <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
        <Container className="pointer-events-none relative z-10 flex h-full flex-col pt-28 md:pt-32 lg:justify-center lg:pt-0">
          <div className="max-w-[460px]">
            <div className="mb-6 flex gap-1.5">
              {STEPS.map((s, i) => (
                <span key={s.k} className={cx("h-[3px] w-10 rounded-full transition-colors duration-500", i <= step ? "bg-signal" : "bg-chalk/15")} />
              ))}
            </div>
            <div className="grid">
              {STEPS.map((s, i) => (
                <div
                  key={s.k}
                  aria-hidden={i !== step}
                  className={cx("[grid-area:1/1] transition-all duration-500", i === step ? "translate-y-0 opacity-100" : i < step ? "-translate-y-4 opacity-0" : "translate-y-4 opacity-0")}
                >
                  <div className="label mb-3 text-signal">{s.k} / 03</div>
                  <h2 className="display-md text-[34px] leading-[1.02] md:text-[56px]">{s.title}</h2>
                  <p className="mt-4 max-w-[420px] text-[15px] leading-relaxed text-chalk/60">{s.body}</p>
                </div>
              ))}
            </div>
            <div className="mt-8 grid grid-cols-2 gap-6 border-t border-chalk/10 pt-6 md:mt-10">
              <div>
                <div className="label flex items-center gap-2 text-chalk/45">{sim ? "GPUs" : "Real nodes"} {grow > 0 && <Prov p={sim ? "simulated" : "live"} />}</div>
                <Odometer fast text={fmtInt(gpus)} className="mt-2 text-[34px] font-medium md:text-[44px]" />
              </div>
              <div>
                <div className="label flex items-center gap-2 text-chalk/45">Memory {grow > 0 && <Prov p={sim ? "simulated" : "live"} />}</div>
                <Odometer fast text={memText} className="mt-2 text-[34px] font-medium md:text-[44px]" />
              </div>
            </div>
            <motion.p style={{ opacity: legend }} className="mt-6 font-mono text-[11px] text-chalk/40">
              {sim ? "1 point = 1 node · orange = serving a request now" : "Illustration of the device-class floorplan · counters above are real"}
            </motion.p>
          </div>
        </Container>
      </div>
    </section>
  );
}
