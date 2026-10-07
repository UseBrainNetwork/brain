"use client";

import { useEffect, useRef, useState } from "react";
import type { ComputeJob, DeviceClass, NetworkEvent } from "@/domain/types";
import { contributor } from "@/network/client/contributor";
import { networkStore } from "@/network/realtime/store";
import { getMode, useSim } from "@/network/realtime/mode";
import { getDeviceClasses } from "@/services/data";
import { cx, fmtInt } from "@/lib/format";

/**
 * Live compute topology.
 * Clusters = device classes (sampled: 1 cell ≈ CELL_RATIO nodes). Real nodes (incl. yours) are
 * drawn 1:1 as distinct markers. Jobs: ingress → router → split into work units → cells →
 * merge → egress. Every animation corresponds to an event in the network store.
 */

export const CELL_RATIO = 8;

const ROUTES: Record<string, DeviceClass[]> = {
  "brain/qwen": ["RTX_4090", "M4_MAX", "RTX_4080", "M3_MAX"],
  "brain/code": ["RTX_4090", "RTX_4080", "RX_7900", "M4_MAX"],
  "brain/embed": ["OTHER_WEBGPU", "M3_MAX", "OTHER_WEBGPU"],
  "brain/vision": ["RTX_4090", "M4_MAX"],
};

const C = {
  bg: "#0d0f13",
  chalk: "230,233,238",
  signal: "61,90,254",
  ok: "39,196,109",
};

interface Pt {
  x: number;
  y: number;
}
interface Cell extends Pt {
  act: number;
  flash: number;
  flashColor: string;
  b: number;
}
interface Cluster {
  id: DeviceClass;
  label: string;
  nodes: number;
  medianScore: number;
  memGb: number;
  cx: number;
  cy: number;
  r: number;
  cells: Cell[];
  port: Pt;
  out: Pt;
}
interface Particle {
  a: Pt;
  b: Pt;
  c: Pt;
  t0: number;
  dur: number;
  color: string;
  width: number;
  done?: () => void;
}
interface FloatLabel {
  x: number;
  y: number;
  text: string;
  t0: number;
  color: string;
  dur: number;
}
interface Marker extends Pt {
  id: string;
  you: boolean;
  born: number;
  act: number;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const quad = (a: Pt, c: Pt, b: Pt, t: number): Pt => {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
};
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** Above this many live markers, per-node labels overlap and are dropped (your own node keeps its label). */
const LABEL_MAX_MARKERS = 40;

export function TopologyCanvas({ className, labels = true, dense = false }: { className?: string; labels?: boolean; dense?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ c: Cluster; x: number; y: number; active: number } | null>(null);
  const sim = useSim();

  useEffect(() => {
    const el = canvas.current!;
    const host = wrap.current!;
    const ctx = el.getContext("2d")!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const profiles = getDeviceClasses();

    let W = 0;
    let H = 0;
    let dpr = 1;
    let clusters: Cluster[] = [];
    let ingress: Pt = { x: 0, y: 0 };
    let router: Pt & { h: number } = { x: 0, y: 0, h: 0 };
    let merge: Pt & { h: number } = { x: 0, y: 0, h: 0 };
    let egress: Pt = { x: 0, y: 0 };
    let pitch = 6;
    let cellSize = 3;
    let bgLayer: HTMLCanvasElement | null = null;
    const particles: Particle[] = [];
    const floats: FloatLabel[] = [];
    const markers = new Map<string, Marker>();
    let ingressHot = 0;
    let egressHot = 0;
    let activeJobs = 0;
    let visible = true;
    let raf = 0;
    let last = performance.now();
    let mouse: Pt | null = null;
    let hovered: Cluster | null = null;

    /* ------------------------------------------------------------ layout */
    const layout = () => {
      const rect = host.getBoundingClientRect();
      W = Math.max(320, rect.width);
      H = Math.max(260, rect.height);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      el.width = Math.round(W * dpr);
      el.height = Math.round(H * dpr);
      el.style.width = `${W}px`;
      el.style.height = `${H}px`;

      const narrow = W < 640;
      const padX = narrow ? 0.06 : 0.035;
      ingress = { x: W * padX, y: H * 0.5 };
      egress = { x: W * (1 - padX), y: H * 0.5 };
      router = { x: W * (narrow ? 0.15 : 0.15), y: H * 0.5, h: H * 0.42 };
      merge = { x: W * (narrow ? 0.85 : 0.86), y: H * 0.5, h: H * 0.42 };

      const gx0 = W * (narrow ? 0.24 : 0.25);
      const gx1 = W * (narrow ? 0.76 : 0.79);
      const gy0 = H * 0.06;
      const gy1 = H * 0.98;
      const cw = (gx1 - gx0) / 3;
      const rh = (gy1 - gy0) / 2;
      const region = (Math.min(cw, rh) / 2) * (narrow ? 0.9 : 0.9);
      const counts = profiles.map((p) => Math.ceil(p.nodes / CELL_RATIO));
      // Shared pitch so disc AREA is honest relative to node count.
      const c = Math.min(...counts.map((n) => region / Math.sqrt(n)));
      pitch = c * 1.77;
      cellSize = Math.max(1.4, pitch * 0.52);

      clusters = profiles.map((p, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const jitterY = (col === 1 ? -1 : 1) * rh * 0.04 * (row === 0 ? 1 : -1);
        const cx0 = gx0 + cw * (col + 0.5);
        const cy0 = gy0 + rh * (row + 0.5) + jitterY + (labels ? 6 : 0);
        const n = counts[i];
        const cells: Cell[] = [];
        for (let j = 0; j < n; j++) {
          const rr = c * Math.sqrt(j + 0.5);
          const th = j * GOLDEN;
          cells.push({ x: cx0 + rr * Math.cos(th), y: cy0 + rr * Math.sin(th), act: 0, flash: 0, flashColor: C.chalk, b: Math.random() });
        }
        const r = c * Math.sqrt(n);
        return {
          id: p.id,
          label: p.label,
          nodes: p.nodes,
          medianScore: p.medianScore,
          memGb: p.nodes * p.advertisedMemoryGb,
          cx: cx0,
          cy: cy0,
          r,
          cells,
          port: { x: router.x + 4, y: router.y - router.h / 2 + (router.h * (i + 0.5)) / profiles.length },
          out: { x: merge.x - 4, y: merge.y - merge.h / 2 + (merge.h * (i + 0.5)) / profiles.length },
        };
      });
      // Re-seat live markers after a resize.
      const seats = new Map<DeviceClass, number>();
      for (const m of markers.values()) {
        const cl = clusterFor(m.id);
        const k = seats.get(cl.id) ?? 0;
        seats.set(cl.id, k + 1);
        Object.assign(m, seatPosition(cl, k));
      }
      bgLayer = renderBackground();
    };

    const seatPosition = (cl: Cluster, k: number): Pt => {
      const n = cl.cells.length + 6 + k * 9;
      const c = cl.r / Math.sqrt(cl.cells.length);
      const rr = c * Math.sqrt(n);
      // Seat on the lower-right rim so the label falls in the gap between clusters.
      const th = 0.45 + k * 0.62;
      return { x: cl.cx + rr * Math.cos(th), y: cl.cy + rr * Math.sin(th) };
    };

    const liveClass = new Map<string, DeviceClass>();
    const liveByClass = new Map<DeviceClass, number>();
    const textWidths = new Map<string, number>();
    const clusterFor = (nodeId: string) => clusters.find((c) => c.id === liveClass.get(nodeId)) ?? clusters[clusters.length - 1];

    const renderBackground = () => {
      const off = document.createElement("canvas");
      off.width = el.width;
      off.height = el.height;
      const g = off.getContext("2d")!;
      g.scale(dpr, dpr);
      g.fillStyle = C.bg;
      g.fillRect(0, 0, W, H);
      // Registration marks.
      g.fillStyle = `rgba(${C.chalk},0.07)`;
      const step = 32;
      for (let x = step / 2; x < W; x += step) for (let y = step / 2; y < H; y += step) g.fillRect(x, y, 1, 1);
      // Wires.
      g.lineWidth = 1;
      g.strokeStyle = `rgba(${C.chalk},0.09)`;
      g.beginPath();
      g.moveTo(ingress.x + 8, ingress.y);
      g.lineTo(router.x - 4, router.y);
      g.moveTo(merge.x + 4, merge.y);
      g.lineTo(egress.x - 8, egress.y);
      for (const cl of clusters) {
        const a = cl.port;
        const b = { x: cl.cx - cl.r - 6, y: cl.cy };
        g.moveTo(a.x, a.y);
        g.bezierCurveTo(a.x + (b.x - a.x) * 0.55, a.y, b.x - (b.x - a.x) * 0.35, b.y, b.x, b.y);
        const o = { x: cl.cx + cl.r + 6, y: cl.cy };
        const m = cl.out;
        g.moveTo(o.x, o.y);
        g.bezierCurveTo(o.x + (m.x - o.x) * 0.35, o.y, m.x - (m.x - o.x) * 0.55, m.y, m.x, m.y);
      }
      g.stroke();
      // Cluster guides.
      for (const cl of clusters) {
        g.strokeStyle = `rgba(${C.chalk},0.06)`;
        g.setLineDash([2, 4]);
        g.beginPath();
        g.arc(cl.cx, cl.cy, cl.r + 7, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
      }
      return off;
    };

    /* ------------------------------------------------------------ spawning */
    const randomCell = (cl: Cluster) => cl.cells[(Math.random() * cl.cells.length) | 0];
    const byId = (id: DeviceClass) => clusters.find((c) => c.id === id)!;

    const spawn = (p: Omit<Particle, "t0">, delay = 0) => particles.push({ ...p, t0: performance.now() + delay });

    const runJob = (job: ComputeJob) => {
      if (activeJobs > (dense ? 14 : 9) || !clusters.length) return;
      activeJobs++;
      const units = Math.max(1, Math.min(job.workUnits, 8));
      const route = ROUTES[job.model] ?? clusters.map((c) => c.id);
      const latency = job.latencyMs ?? 1200;
      const compute = Math.min(1500, Math.max(350, latency * 0.55));
      let returned = 0;
      ingressHot = 1;
      spawn({
        a: { x: ingress.x + 8, y: ingress.y },
        b: { x: router.x - 4, y: router.y },
        c: { x: (ingress.x + router.x) / 2, y: ingress.y },
        dur: 380,
        color: C.signal,
        width: 2.4,
        done: () => {
          for (let u = 0; u < units; u++) {
            const cl = byId(route[(Math.random() * route.length) | 0]) ?? clusters[0];
            const cell = randomCell(cl);
            const from = cl.port;
            spawn(
              {
                a: from,
                b: cell,
                c: { x: from.x + (cell.x - from.x) * 0.6, y: from.y },
                dur: 520 + Math.random() * 220,
                color: C.signal,
                width: 1.6,
                done: () => {
                  cell.act = 1;
                  setTimeout(() => {
                    const to = cl.out;
                    spawn({
                      a: cell,
                      b: to,
                      c: { x: to.x - (to.x - cell.x) * 0.6, y: to.y },
                      dur: 520 + Math.random() * 200,
                      color: C.chalk,
                      width: 1.3,
                      done: () => {
                        if (++returned === units) {
                          spawn({
                            a: { x: merge.x + 4, y: merge.y },
                            b: { x: egress.x - 8, y: egress.y },
                            c: { x: (merge.x + egress.x) / 2, y: merge.y },
                            dur: 340,
                            color: C.chalk,
                            width: 2.2,
                            done: () => {
                              activeJobs--;
                              egressHot = 1;
                              const t = performance.now();
                              const egressBusy = floats.some((f) => f.x === egress.x - 34 && t - f.t0 < f.dur * 0.8);
                              if (labels && !egressBusy && Math.random() < 0.55) {
                                floats.push({ x: egress.x - 34, y: egress.y - 16, text: `#${job.id} ${((job.latencyMs ?? 0) / 1000).toFixed(1)}s`, t0: performance.now(), color: C.chalk, dur: 1600 });
                              }
                            },
                          });
                        }
                      },
                    });
                  }, compute * (0.6 + Math.random() * 0.5));
                },
              },
              u * 35,
            );
          }
        },
      });
    };

    const onEvent = (e: NetworkEvent) => {
      if (!clusters.length || !visible) return;
      if (e.type === "job.submitted" && e.job.provenance === "simulated") runJob(e.job);
      else if (e.type === "node.joined" && e.node.provenance === "simulated") {
        const cell = randomCell(byId(e.node.deviceClass) ?? clusters[5]);
        cell.flash = 1;
        cell.flashColor = C.chalk;
      } else if (e.type === "node.left") {
        const cell = randomCell(clusters[(Math.random() * clusters.length) | 0]);
        cell.flash = 1;
        cell.flashColor = "120,118,112";
      } else if (e.type === "node.verified" && !markers.has(e.nodeId)) {
        const cell = randomCell(clusters[(Math.random() * clusters.length) | 0]);
        cell.flash = 0.8;
        cell.flashColor = C.ok;
      }
    };

    /* ------------------------------------------------------- live markers */
    const syncMarkers = () => {
      const s = networkStore.getSnapshot();
      const ids = new Set(Object.keys(s.liveNodes));
      for (const id of [...markers.keys()]) if (!ids.has(id)) markers.delete(id);
      // Tally once per store change instead of once per frame.
      liveByClass.clear();
      for (const n of Object.values(s.liveNodes)) liveByClass.set(n.deviceClass, (liveByClass.get(n.deviceClass) ?? 0) + 1);
      const seats = new Map<DeviceClass, number>();
      for (const m of markers.values()) {
        const cl = clusterFor(m.id);
        seats.set(cl.id, (seats.get(cl.id) ?? 0) + 1);
      }
      for (const n of Object.values(s.liveNodes)) {
        const existing = markers.get(n.id);
        if (existing) {
          existing.you = n.id === s.localNodeId;
          continue;
        }
        liveClass.set(n.id, n.deviceClass);
        const cl = clusterFor(n.id);
        const k = seats.get(cl.id) ?? 0;
        seats.set(cl.id, k + 1);
        markers.set(n.id, { id: n.id, you: n.id === s.localNodeId, born: performance.now(), act: 0, ...seatPosition(cl, k) });
      }
    };

    let prevJob: { id: string; status: string } | null = null;
    const onContributor = () => {
      const st = contributor.getSnapshot();
      const cur = st.current;
      const me = st.node && markers.get(st.node.id);
      if (!cur || !me) {
        prevJob = cur ? { id: cur.id, status: cur.status } : null;
        return;
      }
      if (prevJob?.id === cur.id && prevJob.status === cur.status) return;
      prevJob = { id: cur.id, status: cur.status };
      const cl = clusterFor(me.id);
      if (cur.status === "received") {
        ingressHot = 1;
        spawn({
          a: { x: ingress.x + 8, y: ingress.y },
          b: { x: router.x - 4, y: router.y },
          c: { x: (ingress.x + router.x) / 2, y: ingress.y },
          dur: 320,
          color: C.signal,
          width: 3,
          done: () =>
            spawn({ a: cl.port, b: me, c: { x: cl.port.x + (me.x - cl.port.x) * 0.6, y: cl.port.y }, dur: 650, color: C.signal, width: 2.6 }),
        });
      } else if (cur.status === "computing") {
        me.act = 1;
      } else if (cur.status === "verifying") {
        spawn({ a: me, b: cl.out, c: { x: cl.out.x - (cl.out.x - me.x) * 0.6, y: cl.out.y }, dur: 520, color: C.chalk, width: 2.2 });
      } else if (cur.status === "verified" || cur.status === "failed") {
        const ok = cur.status === "verified";
        spawn({
          a: { x: merge.x + 4, y: merge.y },
          b: { x: egress.x - 8, y: egress.y },
          c: { x: (merge.x + egress.x) / 2, y: merge.y },
          dur: 300,
          color: ok ? C.ok : C.signal,
          width: 2.6,
          done: () => {
            egressHot = 1;
          },
        });
        floats.push({ x: me.x, y: me.y - 16, text: ok ? `VERIFIED +${cur.units}u` : "REJECTED", t0: performance.now(), color: ok ? C.ok : C.signal, dur: 1800 });
      }
    };

    /* -------------------------------------------------------------- draw */
    const pos = (p: Particle, now: number) => {
      const t = Math.min(1, Math.max(0, (now - p.t0) / p.dur));
      return { t, at: quad(p.a, p.c, p.b, ease(t)) };
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(64, now - last);
      last = now;
      if (!visible || !clusters.length) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (bgLayer) ctx.drawImage(bgLayer, 0, 0, W, H);

      // Ambient load: the network is always doing far more work than we draw jobs for.
      const ambient = (reduced ? 6 : dense ? 70 : 45) * (dt / 1000);
      for (let i = 0; i < ambient; i++) {
        const cl = clusters[(Math.random() * clusters.length) | 0];
        const cell = randomCell(cl);
        cell.act = Math.max(cell.act, 0.22 + Math.random() * 0.3);
      }

      const decay = Math.exp(-dt / 620);
      const flashDecay = Math.exp(-dt / 380);
      const half = cellSize / 2;

      // Idle pass, batched by brightness.
      for (let bucket = 0; bucket < 3; bucket++) {
        ctx.fillStyle = `rgba(${C.chalk},${0.13 + bucket * 0.06})`;
        for (const cl of clusters) {
          const hot = hovered === cl;
          for (const c of cl.cells) {
            if (((c.b * 3) | 0) !== bucket) continue;
            if (hot) continue;
            ctx.fillRect(c.x - half, c.y - half, cellSize, cellSize);
          }
        }
      }
      if (hovered) {
        ctx.fillStyle = `rgba(${C.chalk},0.42)`;
        for (const c of hovered.cells) ctx.fillRect(c.x - half, c.y - half, cellSize, cellSize);
      }

      // Active + flashes.
      for (const cl of clusters) {
        for (const c of cl.cells) {
          if (c.act > 0.03) {
            ctx.fillStyle = `rgba(${C.signal},${Math.min(1, 0.2 + c.act * 0.9)})`;
            const s = cellSize * (1 + c.act * 0.35);
            ctx.fillRect(c.x - s / 2, c.y - s / 2, s, s);
            c.act *= decay;
          } else c.act = 0;
          if (c.flash > 0.03) {
            ctx.strokeStyle = `rgba(${c.flashColor},${c.flash * 0.9})`;
            ctx.lineWidth = 1;
            const rr = cellSize + (1 - c.flash) * pitch * 2.2;
            ctx.strokeRect(c.x - rr / 2, c.y - rr / 2, rr, rr);
            ctx.fillStyle = `rgba(${c.flashColor},${c.flash})`;
            ctx.fillRect(c.x - half, c.y - half, cellSize, cellSize);
            c.flash *= flashDecay;
          }
        }
      }

      // Router / merge / ports.
      ingressHot *= Math.exp(-dt / 500);
      egressHot *= Math.exp(-dt / 500);
      const bar = (p: Pt & { h: number }, hot: number) => {
        ctx.fillStyle = `rgba(${C.chalk},0.1)`;
        roundRect(ctx, p.x - 3, p.y - p.h / 2, 6, p.h, 3);
        ctx.fill();
        if (hot > 0.02) {
          // A short lit segment at the bar's centre, where traffic enters.
          const seg = p.h * (0.18 + 0.12 * hot);
          ctx.fillStyle = `rgba(${C.signal},${0.25 + hot * 0.65})`;
          roundRect(ctx, p.x - 3, p.y - seg / 2, 6, seg, 3);
          ctx.fill();
        }
      };
      bar(router, ingressHot);
      bar(merge, egressHot);
      const port = (p: Pt, hot: number) => {
        ctx.strokeStyle = `rgba(${C.chalk},${0.35 + hot * 0.5})`;
        ctx.lineWidth = 1;
        ctx.strokeRect(p.x - 7, p.y - 7, 14, 14);
        ctx.fillStyle = hot > 0.05 ? `rgba(${C.signal},${0.4 + hot * 0.6})` : `rgba(${C.chalk},0.25)`;
        ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
      };
      port(ingress, ingressHot);
      port(egress, egressHot);

      // Particles as short comets.
      ctx.lineCap = "round";
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        if (now < p.t0) continue;
        const { t, at } = pos(p, now);
        const tail = quad(p.a, p.c, p.b, ease(Math.max(0, t - 0.12)));
        const grad = ctx.createLinearGradient(tail.x, tail.y, at.x, at.y);
        grad.addColorStop(0, `rgba(${p.color},0)`);
        grad.addColorStop(1, `rgba(${p.color},1)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = p.width;
        ctx.beginPath();
        ctx.moveTo(tail.x, tail.y);
        ctx.lineTo(at.x, at.y);
        ctx.stroke();
        ctx.fillStyle = `rgba(${p.color},1)`;
        ctx.fillRect(at.x - p.width / 2, at.y - p.width / 2, p.width, p.width);
        if (t >= 1) {
          particles.splice(i, 1);
          p.done?.();
        }
      }

      // Live markers (real nodes, 1:1).
      for (const m of markers.values()) {
        const age = (now - m.born) / 1000;
        const grow = Math.min(1, age / 0.5);
        const s = Math.max(m.you ? 8 : 5, cellSize * (m.you ? 3 : 1.8)) * ease(grow);
        const burst = m.you ? 3.2 : 2;
        if (age < burst) {
          for (let k = 0; k < 3; k++) {
            const a = Math.max(0, age - k * 0.4);
            const rr = 4 + a * (m.you ? 85 : 50);
            ctx.strokeStyle = `rgba(${m.you ? C.signal : C.ok},${Math.max(0, 0.8 - a / burst)})`;
            ctx.lineWidth = m.you ? 1.5 : 1;
            ctx.beginPath();
            ctx.arc(m.x, m.y, rr, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        if (m.you) {
          const glow = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, s * 3.2);
          glow.addColorStop(0, `rgba(${C.signal},0.35)`);
          glow.addColorStop(1, `rgba(${C.signal},0)`);
          ctx.fillStyle = glow;
          ctx.fillRect(m.x - s * 3.2, m.y - s * 3.2, s * 6.4, s * 6.4);
        }
        if (m.act > 0.02) m.act = Math.max(m.act * Math.exp(-dt / 1400), contributor.getSnapshot().current?.status === "computing" ? 0.85 : 0);
        const pulse = m.you ? 0.75 + 0.25 * Math.sin(now / 260) : 1;
        ctx.fillStyle = m.you ? `rgba(${C.signal},${pulse})` : `rgba(${C.ok},0.95)`;
        ctx.fillRect(m.x - s / 2, m.y - s / 2, s, s);
        if (m.act > 0.05) {
          ctx.strokeStyle = `rgba(${C.signal},${m.act})`;
          ctx.lineWidth = 1;
          const rr = s + 6 + Math.sin(now / 120) * 2;
          ctx.strokeRect(m.x - rr / 2, m.y - rr / 2, rr, rr);
        }
        // Per-node labels only while they are legible. Past a few dozen they overlap into noise, and
        // measuring and drawing text for every live node each frame was the single largest cost on
        // this canvas with hundreds of nodes online.
        if (m.you || (labels && markers.size <= LABEL_MAX_MARKERS)) {
          ctx.font = `600 10px ${MONO}`;
          const text = m.you ? `YOU · NODE ${m.id}` : `LIVE ${m.id}`;
          const lx = m.x + s / 2 + 16;
          const ly = m.y + 14;
          ctx.strokeStyle = `rgba(${m.you ? C.signal : C.ok},0.6)`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(m.x + s / 2 + 1, m.y + s / 2 + 1);
          ctx.lineTo(lx - 3, ly - 2);
          ctx.stroke();
          let tw = textWidths.get(text);
          if (tw == null) textWidths.set(text, (tw = ctx.measureText(text).width));
          ctx.fillStyle = m.you ? `rgba(${C.signal},1)` : `rgba(${C.ok},0.18)`;
          ctx.fillRect(lx - 3, ly - 9, tw + 8, 14);
          ctx.fillStyle = m.you ? "#fff" : `rgba(${C.ok},1)`;
          ctx.fillText(text, lx + 1, ly + 1);
        }
      }

      // Labels.
      if (labels) {
        ctx.font = `500 10px ${MONO}`;
        ctx.textBaseline = "alphabetic";
        for (const cl of clusters) {
          const x = cl.cx - cl.r;
          const y = cl.cy - cl.r - 14;
          ctx.fillStyle = `rgba(${C.chalk},${hovered === cl ? 0.95 : 0.62})`;
          ctx.fillText(cl.label, x, y);
          const w = ctx.measureText(cl.label + "  ").width;
          ctx.fillStyle = `rgba(${C.chalk},0.32)`;
          ctx.fillText(fmtInt((getMode() === "demo" ? cl.nodes : 0) + (liveByClass.get(cl.id) ?? 0)), x + w, y);
        }
        ctx.fillStyle = `rgba(${C.chalk},0.38)`;
        ctx.textAlign = "center";
        ctx.fillText("ROUTER", router.x, router.y + router.h / 2 + 16);
        ctx.fillText("MERGE", merge.x, merge.y + merge.h / 2 + 16);
        ctx.fillText("IN", ingress.x, ingress.y + 22);
        ctx.fillText("OUT", egress.x, egress.y + 22);
        ctx.textAlign = "left";
      }

      // Floating labels.
      ctx.font = `600 10px ${MONO}`;
      ctx.textAlign = "center";
      for (let i = floats.length - 1; i >= 0; i--) {
        const f = floats[i];
        const k = (now - f.t0) / f.dur;
        if (k < 0) continue;
        if (k >= 1) {
          floats.splice(i, 1);
          continue;
        }
        ctx.fillStyle = `rgba(${f.color},${k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.6) / 0.4)})`;
        ctx.fillText(f.text, f.x, f.y - k * 16);
      }
      ctx.textAlign = "left";
    };

    /* -------------------------------------------------------------- wiring */
    layout();
    syncMarkers();
    const ro = new ResizeObserver(() => layout());
    ro.observe(host);
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting && !document.hidden));
    io.observe(host);
    const onVis = () => (visible = !document.hidden);
    document.addEventListener("visibilitychange", onVis);
    const offEvents = networkStore.onEvent(onEvent);
    const offStore = networkStore.subscribe(syncMarkers);
    const offContrib = contributor.subscribe(onContributor);
    document.fonts?.ready.then(() => layout());

    const onMove = (ev: MouseEvent) => {
      const r = el.getBoundingClientRect();
      mouse = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      const hit = clusters.find((c) => Math.hypot(c.cx - mouse!.x, c.cy - mouse!.y) < c.r + 10) ?? null;
      if (hit !== hovered) {
        hovered = hit;
        setHover(hit ? { c: hit, x: hit.cx, y: hit.cy - hit.r, active: 0 } : null);
      }
    };
    const onLeave = () => {
      mouse = null;
      hovered = null;
      setHover(null);
    };
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      offEvents();
      offStore();
      offContrib();
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [labels, dense, sim]);

  return (
    <div ref={wrap} className={cx("relative overflow-hidden", className)}>
      <canvas ref={canvas} className="absolute inset-0 block" aria-label="Live visualization of compute nodes and jobs in the BRAIN network" role="img" />
      {hover && sim && (
        <div
          className="pointer-events-none absolute z-10 w-[210px] -translate-x-1/2 -translate-y-full rounded-lg bg-chalk p-3 text-ink shadow-xl"
          style={{ left: hover.x, top: hover.y - 26 }}
        >
          <div className="mb-2 flex items-center justify-between font-mono text-[11px] font-semibold">
            {hover.c.label} <span className="font-medium text-fog-2">SIM</span>
          </div>
          <div className="space-y-1 font-mono text-[11px]">
            <Row k="nodes" v={fmtInt(hover.c.nodes)} />
            <Row k="pool memory" v={`${(hover.c.memGb / 1000).toFixed(1)} TB`} />
            <Row k="median score" v={fmtInt(hover.c.medianScore)} />
            <Row k="cells drawn" v={`${hover.c.cells.length} (1:${CELL_RATIO})`} />
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-fog-2">{k}</span>
      <span>{v}</span>
    </div>
  );
}

const MONO = '"JetBrains Mono Variable", ui-monospace, monospace';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
