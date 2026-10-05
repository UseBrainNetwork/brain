"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComputeNode, DistributedJob, NetworkEvent, WorkUnitStatus } from "@/domain/types";
import { cx, fmtInt } from "@/lib/format";
import { onRealEvent } from "@/network/realtime/real";

/**
 * Live topology of REAL nodes around the request hub. Work units are drawn as packets that
 * travel hub → node when assigned and node → hub when returned; node labels follow the
 * unit state machine (ONLINE → ASSIGNED → COMPUTING → RETURNING → VERIFIED).
 */

type NodePhase = "ONLINE" | "ASSIGNED" | "COMPUTING" | "RETURNING" | "VERIFIED" | "MISMATCH" | "LOST";

interface Packet {
  id: string;
  nodeId: string;
  dir: "out" | "in";
  tone: "signal" | "ok" | "bad";
  born: number;
}

const W = 1000;
const H = 680;
const CX = W / 2;
const CY = H / 2 + 10;

function phaseFor(nodeId: string, job: DistributedJob | null): NodePhase {
  if (!job || job.status === "completed" || job.status === "failed") {
    if (job && job.units.some((u) => u.nodeId === nodeId && u.status === "verified") && Date.now() - (job.completedAt ?? 0) < 4000) return "VERIFIED";
    return "ONLINE";
  }
  const mine = job.units.filter((u) => u.nodeId === nodeId);
  if (!mine.length) return "ONLINE";
  const has = (s: WorkUnitStatus) => mine.some((u) => u.status === s);
  if (has("computing")) return "COMPUTING";
  if (has("returned")) return "RETURNING";
  if (has("assigned")) return "ASSIGNED";
  if (has("mismatch")) return "MISMATCH";
  if (has("lost")) return "LOST";
  if (mine.every((u) => u.status === "verified" || u.status === "failed")) return "VERIFIED";
  return "ONLINE";
}

const phaseColor: Record<NodePhase, string> = {
  ONLINE: "var(--color-chalk)",
  ASSIGNED: "var(--color-signal)",
  COMPUTING: "var(--color-signal)",
  RETURNING: "var(--color-warn)",
  VERIFIED: "var(--color-ok)",
  MISMATCH: "var(--color-signal)",
  LOST: "var(--color-fog)",
};

export function Topology({ nodes, job, className }: { nodes: ComputeNode[]; job: DistributedJob | null; className?: string }) {
  const ordered = useMemo(() => [...nodes].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id)), [nodes]);
  const n = ordered.length;
  const R = n <= 1 ? 0 : Math.min(250, 170 + n * 10);
  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    ordered.forEach((node, i) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
      m.set(node.id, { x: CX + Math.cos(a) * R, y: CY + Math.sin(a) * R });
    });
    return m;
  }, [ordered, n, R]);

  const [packets, setPackets] = useState<Packet[]>([]);
  const seq = useRef(0);
  const [hubFlash, setHubFlash] = useState<"ok" | "bad" | null>(null);
  const [, bump] = useState(0);
  useEffect(() => {
    const t = setInterval(() => bump((x) => x + 1), 1000); // re-evaluate VERIFIED→ONLINE decay
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const spawn = (nodeId: string, dir: Packet["dir"], tone: Packet["tone"], delay = 0) => {
      setTimeout(() => {
        const id = `${seq.current++}`;
        setPackets((p) => [...p, { id, nodeId, dir, tone, born: Date.now() }]);
        setTimeout(() => setPackets((p) => p.filter((x) => x.id !== id)), 900);
      }, delay);
    };
    return onRealEvent((e: NetworkEvent) => {
      if (e.type === "djob.assigned") e.job.units.forEach((u, i) => spawn(u.nodeId, "out", "signal", i * 55));
      else if (e.type === "work.reassigned") spawn(e.toNodeId, "out", "signal");
      else if (e.type === "work.completed") spawn(e.nodeId, "in", "signal");
      else if (e.type === "work.verified") {
        setHubFlash("ok");
        setTimeout(() => setHubFlash(null), 350);
      } else if (e.type === "work.failed") {
        setHubFlash("bad");
        setTimeout(() => setHubFlash(null), 500);
      }
    });
  }, []);

  const active = job && job.status !== "completed" && job.status !== "failed";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cx("h-full w-full", className)} role="img" aria-label="Live network topology">
      <defs>
        <radialGradient id="hubGlow">
          <stop offset="0" stopColor="var(--color-signal)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--color-signal)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Ring */}
      {n > 1 && <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--color-chalk)" strokeOpacity="0.07" strokeDasharray="2 6" />}

      {/* Edges */}
      {ordered.map((node) => {
        const p = pos.get(node.id)!;
        const ph = phaseFor(node.id, job);
        const lit = ph !== "ONLINE" && ph !== "LOST";
        return (
          <motion.line
            key={`e-${node.id}`}
            x1={CX}
            y1={CY}
            animate={{ x2: p.x, y2: p.y, stroke: lit ? phaseColor[ph] : "var(--color-chalk)", strokeOpacity: lit ? 0.55 : 0.12 }}
            initial={{ x2: CX, y2: CY }}
            transition={{ type: "spring", stiffness: 120, damping: 20 }}
            strokeWidth={lit ? 1.5 : 1}
          />
        );
      })}

      {/* Packets */}
      <AnimatePresence>
        {packets.map((pk) => {
          const p = pos.get(pk.nodeId);
          if (!p) return null;
          const from = pk.dir === "out" ? { cx: CX, cy: CY } : { cx: p.x, cy: p.y };
          const to = pk.dir === "out" ? { cx: p.x, cy: p.y } : { cx: CX, cy: CY };
          return (
            <motion.circle
              key={pk.id}
              r={pk.dir === "out" ? 4 : 3.2}
              fill={pk.tone === "ok" ? "var(--color-ok)" : pk.tone === "bad" ? "var(--color-signal)" : pk.dir === "in" ? "var(--color-warn)" : "var(--color-signal)"}
              initial={{ ...from, opacity: 0 }}
              animate={{ ...to, opacity: [0, 1, 1, 0.6] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.75, ease: [0.3, 0.6, 0.2, 1] }}
            />
          );
        })}
      </AnimatePresence>

      {/* Hub */}
      <g>
        {active && <circle cx={CX} cy={CY} r={70} fill="url(#hubGlow)" />}
        <motion.circle
          cx={CX}
          cy={CY}
          r={34}
          fill="var(--color-ink-2)"
          animate={{ stroke: hubFlash === "ok" ? "var(--color-ok)" : hubFlash === "bad" ? "var(--color-signal)" : active ? "var(--color-signal)" : "var(--color-chalk)", strokeOpacity: hubFlash ? 1 : active ? 0.9 : 0.35 }}
          strokeWidth={hubFlash ? 3 : 1.5}
        />
        {active && <motion.circle cx={CX} cy={CY} r={34} fill="none" stroke="var(--color-signal)" strokeOpacity={0.5} animate={{ r: [34, 56], opacity: [0.6, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }} />}
        <text x={CX} y={CY - 2} textAnchor="middle" fill="var(--color-chalk)" fontSize="11" fontFamily="var(--font-mono)" letterSpacing="1.5">
          {active ? (job!.status === "verifying" ? "VERIFY" : job!.status === "computing" ? "RUNNING" : "SPLIT") : "REQUEST"}
        </text>
        <text x={CX} y={CY + 12} textAnchor="middle" fill="var(--color-chalk)" fillOpacity="0.45" fontSize="9" fontFamily="var(--font-mono)" letterSpacing="1">
          {job ? `JOB #${job.id}` : "BRAIN"}
        </text>
      </g>

      {/* Nodes */}
      <AnimatePresence>
        {ordered.map((node) => {
          const p = pos.get(node.id)!;
          const ph = phaseFor(node.id, job);
          const color = phaseColor[ph];
          const units = job?.units.filter((u) => u.nodeId === node.id) ?? [];
          const labelBelow = p.y >= CY;
          return (
            <motion.g
              key={node.id}
              initial={{ opacity: 0, scale: 0.2, x: CX - p.x, y: CY - p.y }}
              animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, scale: 0.4 }}
              transition={{ type: "spring", stiffness: 140, damping: 18 }}
              style={{ originX: `${p.x}px`, originY: `${p.y}px` }}
            >
              <motion.circle cx={p.x} cy={p.y} r={30} fill="var(--color-ink-2)" animate={{ stroke: color, strokeOpacity: ph === "ONLINE" ? 0.35 : 1 }} strokeWidth={ph === "ONLINE" ? 1.2 : 2} />
              <motion.circle key={`${node.id}-${node.joinedAt}`} cx={p.x} cy={p.y} r={30} fill="none" stroke="var(--color-ok)" initial={{ r: 30, opacity: 0.9 }} animate={{ r: 70, opacity: 0 }} transition={{ duration: 1.4, ease: "easeOut" }} />
              {ph === "COMPUTING" && (
                <motion.circle cx={p.x} cy={p.y} r={24} fill="none" stroke="var(--color-signal)" strokeWidth={2} strokeDasharray="20 130" animate={{ rotate: 360 }} transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }} style={{ originX: `${p.x}px`, originY: `${p.y}px` }} />
              )}
              <text x={p.x} y={p.y + 4} textAnchor="middle" fill="var(--color-chalk)" fontSize="13" fontWeight="600" fontFamily="var(--font-mono)" letterSpacing="1">
                {node.id}
              </text>
              {/* Unit dots */}
              {units.length > 0 && (
                <g>
                  {units.slice(0, 12).map((u, i) => (
                    <rect
                      key={u.id}
                      x={p.x - (Math.min(units.length, 12) * 7) / 2 + i * 7}
                      y={p.y + (labelBelow ? -46 : 38)}
                      width={5}
                      height={5}
                      fill={u.status === "verified" ? "var(--color-ok)" : u.status === "computing" ? "var(--color-signal)" : u.status === "returned" ? "var(--color-warn)" : u.status === "mismatch" || u.status === "lost" || u.status === "failed" ? "var(--color-signal)" : "var(--color-chalk)"}
                      fillOpacity={u.status === "assigned" ? 0.35 : 1}
                    />
                  ))}
                </g>
              )}
              <text x={p.x} y={p.y + (labelBelow ? 50 : -40)} textAnchor="middle" fill={color} fontSize="10" fontFamily="var(--font-mono)" letterSpacing="1.5">
                {ph}
              </text>
              <text x={p.x} y={p.y + (labelBelow ? 64 : -54)} textAnchor="middle" fill="var(--color-chalk)" fillOpacity="0.45" fontSize="9.5" fontFamily="var(--font-mono)" letterSpacing="1">
                COMPUTE {fmtInt(node.computeScore)}
              </text>
            </motion.g>
          );
        })}
      </AnimatePresence>

      {n === 0 && (
        <text x={CX} y={CY + 110} textAnchor="middle" fill="var(--color-chalk)" fillOpacity="0.4" fontSize="12" fontFamily="var(--font-mono)" letterSpacing="2">
          NO REAL NODES · OPEN /node ON A DEVICE AND JOIN
        </text>
      )}
    </svg>
  );
}
