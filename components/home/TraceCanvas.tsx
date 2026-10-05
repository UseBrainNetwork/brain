"use client";

import { useEffect, useRef } from "react";

/**
 * The request's path drawn as a live circuit trace. Scrubbed by scroll (stage progress `s` in [0, 8)),
 * with time-based motion along every lit segment. Example trace; nothing here is live network data.
 */

const MONO = '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace';
const CHALK = (a: number) => `rgba(230,233,238,${a})`;
const SIG = (a: number) => `rgba(61,90,254,${a})`;
const SIG2 = (a: number) => `rgba(140,160,255,${a})`;
const OK = (a: number) => `rgba(39,196,109,${a})`;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const hash = (i: number, j: number) => {
  const x = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

type Pt = { x: number; y: number };
const bez = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt => {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
};
const vertCurve = (a: Pt, b: Pt): [Pt, Pt, Pt, Pt] => [a, { x: a.x, y: lerp(a.y, b.y, 0.55) }, { x: b.x, y: lerp(a.y, b.y, 0.45) }, b];

export function TraceCanvas({ s, nodes }: { s: number; nodes: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const sRef = useRef(s);
  sRef.current = s;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let W = 0;
    let H = 0;
    let dpr = 1;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width;
      H = r.height;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0 });
    io.observe(canvas);

    const t0 = performance.now();
    let raf = 0;
    // faint dot grid for depth
    const tile = document.createElement("canvas");
    tile.width = tile.height = 24;
    const tctx = tile.getContext("2d");
    if (tctx) {
      tctx.fillStyle = CHALK(0.09);
      tctx.fillRect(11, 11, 1.5, 1.5);
    }
    const grid = ctx.createPattern(tile, "repeat");

    const label = (text: string, x: number, y: number, color: string, align: CanvasTextAlign = "left", size = 10, weight = 500) => {
      ctx.font = `${weight} ${size}px ${MONO}`;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    };
    const rrect = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
    };
    const glow = (x: number, y: number, r: number, rgb: string, a: number) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(0.35, `rgba(${rgb},${a * 0.35})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    const packet = (x: number, y: number, rgb = "61,90,254", scale = 1) => {
      glow(x, y, 22 * scale, rgb, 0.55);
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(x, y, 2.6 * scale, 0, Math.PI * 2);
      ctx.fill();
    };
    /** Strokes a cubic bezier up to parameter `t`, returning the end point. */
    const strokeCurve = (c: [Pt, Pt, Pt, Pt], t: number, style: string, width: number, dash?: number[], dashOffset = 0) => {
      const tt = clamp01(t);
      const m = Math.max(2, Math.round(28 * tt));
      ctx.beginPath();
      ctx.moveTo(c[0].x, c[0].y);
      let last = c[0];
      for (let i = 1; i <= m; i++) {
        last = bez(c[0], c[1], c[2], c[3], (i / m) * tt);
        ctx.lineTo(last.x, last.y);
      }
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.setLineDash(dash ?? []);
      ctx.lineDashOffset = dashOffset;
      ctx.stroke();
      ctx.setLineDash([]);
      return last;
    };
    const flowLine = (c: [Pt, Pt, Pt, Pt], t: number, rgb: string, time: number, alpha = 1) => {
      strokeCurve(c, t, `rgba(${rgb},${0.55 * alpha})`, 1.25);
      if (!reduce) strokeCurve(c, t, `rgba(${rgb},${0.9 * alpha})`, 1.25, [3, 11], -time * 46);
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!visible || W === 0) return;
      const time = (performance.now() - t0) / 1000;
      const sv = sRef.current;
      const T = Array.from({ length: 8 }, (_, i) => clamp01(sv - i));
      const E = T.map(ease);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0.06em";
      if (grid) {
        ctx.fillStyle = grid;
        ctx.fillRect(0, 0, W, H);
      }

      // ---- geometry
      const cx = W / 2;
      const narrow = W < 560;
      const ruler = (text: string, y: number) => {
        if (!narrow) label(text, 2, y, CHALK(0.3), "left", 9);
      };
      const yReq = H * 0.045;
      const yGate = H * 0.16;
      const yRoute = H * 0.255;
      const yRouteEnd = H * 0.34;
      const ySplit = H * 0.405;
      const yTile = H * 0.51;
      const tileH = Math.min(118, H * 0.18);
      const yTileBot = yTile + tileH;
      const yMerge = H * 0.815;
      const yResp = H * 0.935;
      const margin = Math.max(8, W * 0.03);
      const gap = Math.max(12, W * 0.025);
      const tileW = Math.min(150, (W - margin * 2 - gap * 3) / 4);
      const span = tileW * 4 + gap * 3;
      const tx = nodes.map((_, i) => cx - span / 2 + i * (tileW + gap) + tileW / 2);

      // ---- spine (request → split)
      const packetY = sv < 1 ? lerp(yReq + 14, yGate, E[0]) : sv < 2 ? lerp(yGate, yRoute, E[1]) : sv < 3 ? lerp(yRoute, ySplit, E[2]) : ySplit;
      ctx.strokeStyle = CHALK(0.1);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, yReq + 14);
      ctx.lineTo(cx, ySplit);
      ctx.stroke();
      if (sv > 0) {
        ctx.strokeStyle = SIG(0.7);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, yReq + 14);
        ctx.lineTo(cx, packetY);
        ctx.stroke();
        if (!reduce) {
          ctx.strokeStyle = SIG2(0.9);
          ctx.setLineDash([3, 11]);
          ctx.lineDashOffset = -time * 46;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // ---- request port
      {
        const w = Math.min(230, W * 0.5);
        const lit = sv > 0;
        rrect(cx - w / 2, yReq - 14, w, 28, 6);
        ctx.fillStyle = lit ? SIG(0.14) : CHALK(0.03);
        ctx.fill();
        ctx.strokeStyle = lit ? SIG(0.9) : CHALK(0.22);
        ctx.lineWidth = 1;
        ctx.stroke();
        label("POST /v1/chat/completions", cx, yReq, lit ? CHALK(0.95) : CHALK(0.5), "center", 10.5);
        ruler("REQUEST", yReq);
        if (sv < 3) packet(cx, packetY);
      }

      // ---- gateway
      {
        const w = Math.min(420, W * 0.72);
        const checks = ["AUTH", "RATE 18/60", "SCHEMA"];
        const thresholds = [0.3, 0.58, 0.86];
        ctx.strokeStyle = CHALK(sv > 1 ? 0.22 : 0.12);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - w / 2, yGate);
        ctx.lineTo(cx + w / 2, yGate);
        ctx.stroke();
        ruler("GATEWAY", yGate);
        checks.forEach((c, i) => {
          const x = cx - w / 2 + (w / (checks.length + 1)) * (i + 1);
          const passed = T[1] > thresholds[i];
          ctx.fillStyle = passed ? OK(0.95) : CHALK(0.15);
          ctx.fillRect(x - 4, yGate + 10, 8, 8);
          label(c, x, yGate + 26, passed ? OK(0.9) : CHALK(0.35), "center", 9);
          if (passed && T[1] < thresholds[i] + 0.12 && !reduce) glow(x, yGate + 14, 20, "39,196,109", 0.5);
        });
        if (sv >= 1 && sv < 2) {
          // gate flash as packet crosses
          const k = 1 - clamp01(T[1] * 3);
          if (k > 0) glow(cx, yGate, 60, "61,90,254", 0.45 * k);
        }
      }

      // ---- router
      {
        const cands = narrow
          ? [
              { k: "CLOUD", cost: "$0.0090", lat: "0.9s", dx: -0.34 },
              { k: "BROWSER", cost: "$0.0021", lat: "1.8s", dx: 0 },
              { k: "EXTERNAL", cost: "$0.0150", lat: "1.1s", dx: 0.34 },
            ]
          : [
              { k: "CLOUD_GPU", cost: "$0.0090", lat: "0.9s", dx: -0.3 },
              { k: "BROWSER_NETWORK", cost: "$0.0021", lat: "1.8s", dx: 0 },
              { k: "EXTERNAL", cost: "$0.0150", lat: "1.1s", dx: 0.3 },
            ];
        ruler("ROUTER", yRouteEnd);
        if (sv > 2) {
          const show = ease(clamp01(T[2] * 2)); // 0..0.5 → candidates appear
          const pick = ease(clamp01((T[2] - 0.55) / 0.45)); // 0.55..1 → decision
          cands.forEach((c) => {
            const end = { x: cx + c.dx * Math.min(W, 640), y: yRouteEnd };
            const chosen = c.dx === 0;
            const a = chosen ? lerp(0.35, 1, pick) : lerp(0.35, 0.08, pick);
            const curve = vertCurve({ x: cx, y: yRoute }, end);
            if (chosen && pick > 0) flowLine(curve, show, "61,90,254", time, pick);
            strokeCurve(curve, show, chosen ? SIG(0.3 + 0.4 * (1 - pick)) : CHALK(a * 0.8), 1);
            const la = show * a;
            ctx.fillStyle = chosen && pick > 0.5 ? SIG(0.9) : CHALK(la);
            ctx.fillRect(end.x - 3, end.y - 3, 6, 6);
            // labels sit beside the endpoint, never below it, so the router row stays one line tall
            // side candidates label outward on wide screens, below the dot on narrow ones
            const side: CanvasTextAlign = narrow && !chosen ? "center" : c.dx < 0 ? "right" : "left";
            const lx = narrow && !chosen ? end.x : end.x + (c.dx < 0 ? -10 : 10);
            const ly = narrow && !chosen ? end.y + 16 : end.y;
            const col = chosen ? (pick > 0.5 ? SIG2(1) : CHALK(la * 1.2)) : CHALK(la * 1.3);
            label(c.k, lx, ly - 6, col, side, 9.5, 600);
            label(narrow ? c.cost : `${c.cost}  ·  ${c.lat}`, lx, ly + 7, chosen && pick > 0.5 ? CHALK(0.6) : CHALK(la * 0.8), side, 9);
            if (chosen && pick > 0.6) {
              const tw = 66;
              rrect(end.x - 10 - tw, end.y - 7, tw, 14, 3);
              ctx.fillStyle = SIG(0.18 * pick);
              ctx.fill();
              label("CHEAPEST", end.x - 10 - tw / 2, end.y, SIG2(pick), "center", 8.5, 600);
            }
          });
        }
      }

      // ---- split fan → tiles
      {
        ruler("SPLIT", ySplit);
        if (sv > 3) {
          nodes.forEach((_, i) => {
            const curve = vertCurve({ x: cx, y: ySplit }, { x: tx[i], y: yTile });
            const t = ease(clamp01(T[3] * 1.25 - i * 0.06));
            strokeCurve(curve, 1, CHALK(0.08), 1);
            if (t > 0) {
              flowLine(curve, t, "61,90,254", time + i * 0.37);
              const end = bez(curve[0], curve[1], curve[2], curve[3], t);
              if (t < 1) packet(end.x, end.y, "61,90,254", 0.85);
            }
          });
          if (!reduce && T[3] < 0.2) glow(cx, ySplit, 40, "61,90,254", 0.5 * (1 - T[3] * 5));
        }
      }

      // ---- tiles (nodes / verify / credit)
      {
        const cols = Math.max(6, Math.floor(tileW / 11));
        const rows = 6;
        const pad = 8;
        const cw = (tileW - pad * 2 - (cols - 1) * 2) / cols;
        const chH = (tileH - 34 - pad - (rows - 1) * 2) / rows;
        ruler("NODES", yTile + tileH / 2);
        nodes.forEach((id, i) => {
          const x0 = tx[i] - tileW / 2;
          const appear = sv > 3 ? ease(clamp01(T[3] * 1.5 - i * 0.08)) : 0;
          const computing = clamp01(T[4] * 1.3 - i * 0.07);
          const v = clamp01(T[5] * 4.4 - i * 1.05); // verification sweep per tile
          const verified = v >= 1;
          const credited = T[7] > 0.35;
          ctx.globalAlpha = Math.max(0.18, appear);
          rrect(x0, yTile, tileW, tileH, 6);
          ctx.fillStyle = verified ? OK(0.05) : SIG(0.04 * computing);
          ctx.fill();
          ctx.strokeStyle = verified ? OK(0.8) : computing > 0 ? SIG(0.35 + 0.35 * computing) : CHALK(0.18);
          ctx.lineWidth = 1;
          ctx.stroke();
          const small = tileW < 110;
          label(small ? id : `NODE ${id}`, x0 + pad, yTile + 13, CHALK(0.8), "left", 9.5, 600);
          if (verified) {
            ctx.strokeStyle = OK(1);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x0 + tileW - pad - 10, yTile + 13);
            ctx.lineTo(x0 + tileW - pad - 6, yTile + 17);
            ctx.lineTo(x0 + tileW - pad, yTile + 9);
            ctx.stroke();
          } else {
            label(small ? String.fromCharCode(65 + i) : `UNIT ${String.fromCharCode(65 + i)}`, x0 + tileW - pad, yTile + 13, computing > 0 ? SIG2(0.9) : CHALK(0.35), "right", 9);
          }
          // cells
          const gy = yTile + 24;
          const scanRow = v > 0 && v < 1 ? Math.floor(v * rows) : -1;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const cxp = x0 + pad + c * (cw + 2);
              const cyp = gy + r * (chH + 2);
              const h = hash(i * 97 + r, c);
              let fill = CHALK(0.06);
              if (verified) fill = OK(0.1 + 0.12 * h);
              else if (computing > 0) {
                const phase = Math.sin(time * (2.2 + h * 3.4) + h * 40 + i) * 0.5 + 0.5;
                const heat = computing * (phase > 0.55 ? (phase - 0.55) / 0.45 : 0);
                fill = heat > 0.02 ? SIG(0.15 + heat * 0.8) : CHALK(0.07);
              }
              if (r === scanRow) fill = OK(0.85);
              else if (scanRow >= 0 && r < scanRow) fill = OK(0.18 + 0.1 * h);
              ctx.fillStyle = fill;
              ctx.fillRect(cxp, cyp, cw, chH);
            }
          }
          if (scanRow >= 0 && !reduce) glow(tx[i], gy + scanRow * (chH + 2) + chH / 2, tileW * 0.6, "39,196,109", 0.25);
          // footer line
          const fy = yTile + tileH - 9;
          const sc = small ? "" : "SPOT-CHECK ";
          if (verified) label(`${sc}8/8`, x0 + pad, fy, OK(0.9), "left", 8.5, 600);
          else if (v > 0) label(`${sc}${Math.floor(v * 8)}/8`, x0 + pad, fy, OK(0.7), "left", 8.5, 600);
          else if (computing > 0) {
            ctx.fillStyle = CHALK(0.1);
            ctx.fillRect(x0 + pad, fy - 1, tileW - pad * 2, 2);
            ctx.fillStyle = SIG(0.9);
            ctx.fillRect(x0 + pad, fy - 1, (tileW - pad * 2) * computing, 2);
          } else label("IDLE", x0 + pad, fy, CHALK(0.3), "left", 8.5);
          if (credited) {
            const k = ease(clamp01((T[7] - 0.35) / 0.4));
            label("+8u", x0 + tileW - pad, fy - (1 - k) * 6, OK(k), "right", 10, 600);
          }
          ctx.globalAlpha = 1;
        });
      }

      // ---- merge
      {
        ruler("MERGE", yMerge);
        nodes.forEach((_, i) => {
          const curve = vertCurve({ x: tx[i], y: yTileBot }, { x: cx, y: yMerge });
          strokeCurve(curve, 1, CHALK(0.07), 1);
          const t = ease(clamp01(T[6] * 1.3 - i * 0.07));
          if (t > 0) {
            flowLine(curve, t, "39,196,109", time + i * 0.41);
            if (t < 1) {
              const p = bez(curve[0], curve[1], curve[2], curve[3], t);
              packet(p.x, p.y, "39,196,109", 0.85);
            }
          }
        });
        if (T[6] > 0.75) {
          const k = ease((T[6] - 0.75) / 0.25);
          ctx.fillStyle = OK(0.95 * k);
          ctx.fillRect(cx - 3, yMerge - 3, 6, 6);
          label("4/4 in order  ·  hash 9f3c…e1a0", cx, yMerge + 15, CHALK(0.65 * k), "center", 9.5);
          if (!reduce && T[6] < 0.95) glow(cx, yMerge, 46, "39,196,109", 0.5 * (1 - (T[6] - 0.75) / 0.2));
        }
      }

      // ---- response
      {
        const w = Math.min(300, W * 0.6);
        const k = ease(T[7] * 2);
        ctx.strokeStyle = CHALK(0.1);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, yMerge);
        ctx.lineTo(cx, yResp - 14);
        ctx.stroke();
        if (k > 0) {
          const curve: [Pt, Pt, Pt, Pt] = [{ x: cx, y: yMerge }, { x: cx, y: yMerge }, { x: cx, y: yResp - 14 }, { x: cx, y: yResp - 14 }];
          flowLine(curve, k, "39,196,109", time);
        }
        rrect(cx - w / 2, yResp - 14, w, 28, 6);
        ctx.fillStyle = k > 0 ? OK(0.12 * k) : CHALK(0.03);
        ctx.fill();
        ctx.strokeStyle = k > 0 ? OK(0.9) : CHALK(0.18);
        ctx.stroke();
        label(k > 0 ? (narrow ? "200 OK  ·  r-918282  ·  1.79s" : "200 OK  ·  receipt r-918282  ·  1.79s") : "awaiting response", cx, yResp, k > 0 ? CHALK(0.95) : CHALK(0.35), "center", 10.5);
        ruler("RESPONSE", yResp);
        if (k > 0 && !reduce) {
          const ring = (time * 0.9) % 1;
          ctx.strokeStyle = OK(0.5 * (1 - ring) * k);
          ctx.lineWidth = 1;
          rrect(cx - w / 2 - ring * 14, yResp - 14 - ring * 14, w + ring * 28, 28 + ring * 28, 6 + ring * 10);
          ctx.stroke();
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, [nodes]);

  return <canvas ref={ref} className="absolute inset-0 size-full" aria-hidden />;
}
