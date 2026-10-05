"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { ComputeJob, NetworkEvent } from "@/domain/types";
import { Prov } from "@/components/ui";
import { networkStore, useNetwork } from "@/network/realtime/store";
import { cx, fmtCompact, fmtInt, fmtMs } from "@/lib/format";

const LANE_H = 58;
const VERIFY = { id: "verification", label: "VERIFICATION", model: "verify/*", status: "online" as const };

type Lane = { id: string; label: string; model: string; nodes?: number; rps?: number; status: string };
type Pulse = { lane: number; t0: number; done: boolean; ambient?: boolean };

function laneFor(model: string, lanes: Lane[]) {
  if (model.startsWith("verify/")) return lanes.length - 1;
  const i = lanes.findIndex((l) => l.model === model);
  return i >= 0 ? i : -1;
}

/** Live router view: every simulated request is drawn from the router to the pool that serves it. */
export function Switchboard({ className }: { className?: string }) {
  const pools = useNetwork((s) => s.pools);
  const rps = useNetwork((s) => s.metrics.requestsPerSec);
  const lanes: Lane[] = [...pools.map((p) => ({ id: p.id, label: p.label, model: p.model, nodes: p.nodes, rps: p.requestsPerSec, status: p.status })), VERIFY];
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;

  const [incoming, setIncoming] = useState<ComputeJob[]>([]);
  const [last, setLast] = useState<Record<number, { ms: number; at: number }>>({});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pulses = useRef<Pulse[]>([]);

  useEffect(() => {
    return networkStore.onEvent((e: NetworkEvent) => {
      if (e.type === "job.submitted") {
        const lane = laneFor(e.job.model, lanesRef.current);
        if (lane < 0) return;
        setIncoming((xs) => [e.job, ...xs].slice(0, 6));
        pulses.current.push({ lane, t0: performance.now(), done: false });
        if (pulses.current.length > 60) pulses.current.splice(0, pulses.current.length - 60);
      } else if (e.type === "job.completed") {
        const lane = laneFor(e.job.model, lanesRef.current);
        if (lane < 0) return;
        pulses.current.push({ lane, t0: performance.now(), done: true });
        setLast((m) => ({ ...m, [lane]: { ms: e.job.latencyMs ?? 0, at: Date.now() } }));
      }
    });
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    let w = 0;
    let h = 0;
    const ro = new ResizeObserver(() => {
      const dpr = Math.min(2, devicePixelRatio);
      w = c.clientWidth;
      h = c.clientHeight;
      c.width = w * dpr;
      c.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    ro.observe(c);

    const curve = (lane: number) => {
      const n = lanesRef.current.length;
      const y0 = h / 2;
      const y1 = (h - n * LANE_H) / 2 + lane * LANE_H + LANE_H / 2;
      return { x0: 0, y0, x1: w, y1 };
    };
    const at = (k: ReturnType<typeof curve>, t: number) => {
      const mx = k.x1 * 0.5;
      const u = 1 - t;
      const x = u * u * u * k.x0 + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * k.x1;
      const y = u * u * u * k.y0 + 3 * u * u * t * k.y0 + 3 * u * t * t * k.y1 + t * t * t * k.y1;
      return { x, y };
    };

    let prev = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      if (!w) return;
      const ls = lanesRef.current;
      const total = ls.reduce((a, l) => a + (l.rps ?? 30), 0);
      let budget = total * 0.045 * dt;
      while (budget > 0 && pulses.current.length < 90) {
        if (Math.random() > budget) break;
        budget -= 1;
        let r = Math.random() * total;
        let lane = 0;
        while (lane < ls.length - 1 && (r -= ls[lane].rps ?? 30) > 0) lane++;
        pulses.current.push({ lane, t0: now, done: false, ambient: true });
      }
      ctx.clearRect(0, 0, w, h);
      const n = lanesRef.current.length;
      for (let i = 0; i < n; i++) {
        const k = curve(i);
        ctx.beginPath();
        ctx.moveTo(k.x0, k.y0);
        ctx.bezierCurveTo(k.x1 * 0.5, k.y0, k.x1 * 0.5, k.y1, k.x1, k.y1);
        ctx.strokeStyle = "rgba(230,233,238,0.1)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const DUR = 900;
      pulses.current = pulses.current.filter((p) => now - p.t0 < DUR);
      for (const p of pulses.current) {
        const t = (now - p.t0) / DUR;
        const k = curve(p.lane);
        const e = p.done ? 1 - t : t;
        const head = at(k, Math.min(1, e));
        const tail = at(k, Math.max(0, Math.min(1, p.done ? e + 0.12 : e - 0.12)));
        const g = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
        const col = p.ambient ? "230,233,238" : p.done ? "39,196,109" : "61,90,254";
        const a = p.ambient ? 0.35 : 0.95;
        g.addColorStop(0, `rgba(${col},0)`);
        g.addColorStop(1, `rgba(${col},${a})`);
        ctx.beginPath();
        ctx.moveTo(tail.x, tail.y);
        ctx.lineTo(head.x, head.y);
        ctx.strokeStyle = g;
        ctx.lineWidth = p.ambient ? 1 : 2.4;
        ctx.lineCap = "round";
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(head.x, head.y, p.ambient ? 1.1 : 2.6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${col},${p.ambient ? 0.6 : 1})`;
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const height = lanes.length * LANE_H;

  return (
    <div data-theme="dark" className={cx("overflow-hidden rounded-[22px] bg-ink text-chalk ring-1 ring-black/30", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-chalk/[0.07] px-5 py-3.5 font-mono text-[11px] text-chalk/45">
        <span className="flex items-center gap-2 uppercase tracking-[0.08em]">
          Router · live placement <Prov p="simulated" />
        </span>
        <span className="hidden items-center gap-4 lg:flex">
          <span className="flex items-center gap-1.5"><i className="h-[2px] w-3 bg-signal" />dispatched job</span>
          <span className="flex items-center gap-1.5"><i className="h-[2px] w-3 bg-ok" />verified result</span>
          <span className="flex items-center gap-1.5"><i className="h-px w-3 bg-chalk/40" />background traffic, sampled by pool req/s</span>
        </span>
        <span className="num text-chalk/70">{fmtInt(rps)} req/s</span>
      </div>
      <div className="grid grid-cols-[1fr] md:grid-cols-[230px_150px_minmax(0,1fr)_1.4fr]" style={{ minHeight: height + 40 }}>
        <div className="hidden flex-col justify-center gap-1.5 border-r border-chalk/[0.07] px-5 py-5 md:flex">
          <div className="label mb-2 text-chalk/35">Incoming</div>
          <AnimatePresence initial={false}>
            {incoming.map((j, i) => (
              <motion.div
                key={j.id}
                layout
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1 - i * 0.14, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="flex items-center justify-between font-mono text-[11.5px]"
              >
                <span className="text-chalk/80">#{j.id}</span>
                <span className="text-chalk/40">{j.model}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <div className="hidden items-center justify-center md:flex">
          <div className="relative grid size-[104px] place-items-center rounded-[18px] bg-[#1c1c1a] ring-1 ring-chalk/15">
            <div className="absolute inset-[-7px] rounded-[24px] ring-1 ring-chalk/[0.06]" />
            <div className="text-center">
              <div className="font-mono text-[10px] text-chalk/40">brain/auto</div>
              <div className="mt-1 text-[15px] font-semibold tracking-tight">ROUTER</div>
              <div className="mt-1 flex justify-center gap-1">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="size-1 animate-pulse rounded-full bg-signal" style={{ animationDelay: `${i * 0.25}s` }} />
                ))}
              </div>
            </div>
          </div>
        </div>

        <canvas ref={canvasRef} className="hidden h-full w-full md:block" style={{ height: height + 40 }} />

        <div className="flex flex-col justify-center px-5 py-5 md:pl-0">
          {lanes.map((l, i) => {
            const hit = last[i];
            const fresh = hit && Date.now() - hit.at < 1400;
            return (
              <div key={l.id} className="flex items-center gap-4 border-b border-chalk/[0.07] last:border-0" style={{ height: LANE_H }}>
                <span className={cx("h-8 w-[3px] shrink-0 rounded-full transition-colors duration-500", fresh ? "bg-ok" : "bg-chalk/15")} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] font-semibold tracking-tight">{l.label}</span>
                    {l.status === "beta" && <span className="rounded bg-warn/20 px-1 font-mono text-[9px] font-semibold text-warn">BETA</span>}
                  </div>
                  <div className="font-mono text-[10.5px] text-chalk/40">{l.model}</div>
                </div>
                <div className="text-right font-mono text-[11px]">
                  <div className="num text-chalk/80">{l.nodes != null ? `${fmtCompact(l.nodes, 1)} nodes` : "canaries"}</div>
                  <div className={cx("transition-colors", fresh ? "text-ok" : "text-chalk/35")}>{hit ? fmtMs(hit.ms) : "—"}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
