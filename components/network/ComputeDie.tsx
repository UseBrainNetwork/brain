"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { ComputeJob, DeviceClass, NetworkEvent } from "@/domain/types";
import { contributor } from "@/network/client/contributor";
import { networkStore } from "@/network/realtime/store";
import { getMode, useSim } from "@/network/realtime/mode";
import { getDeviceClasses } from "@/services/data";
import { cx, fmtInt } from "@/lib/format";

/**
 * The network rendered as one compute die. Every cell is one node (1:1, not sampled).
 * Districts are device classes, sized by node count on a uniform pitch, like a floorplan.
 * - simulated jobs: signals travel from the IN pad along the bus, cells rise + heat, then flash on merge
 * - ambient activity: proportional to network req/s
 * - real nodes connected to this server: pillars (yours is orange, labeled)
 */

const PITCH = 0.062;
/** Above this many live pillars, per-node labels and shadows are dropped (your own node keeps both). */
const LABEL_MAX_PILLARS = 40;
const COL_BUDGET = 150;
const GAP_COLS = 3;
const MARGIN = 0.42;
const ROW_GAP = 0.34; // bus lane between the two rows of districts
const THICK = 0.26;
const SUB_PAD = 0.55; // ceramic package substrate around the die
const SUB_THICK = 0.16;
const ROWS: DeviceClass[][] = [
  ["RTX_4090", "M4_MAX", "RTX_4080"],
  ["M3_MAX", "RX_7900", "OTHER_WEBGPU"],
];
const MAX_PULSES = 160;
const TRAIL = 5;

interface District {
  id: DeviceClass;
  label: string;
  nodes: number;
  medianScore: number;
  x0: number;
  z0: number;
  cols: number;
  rows: number;
  first: number;
}
interface Pulse {
  pts: [number, number][];
  lens: number[];
  total: number;
  t0: number;
  dur: number;
  color: [number, number, number];
  done?: () => void;
}
interface Hover {
  d: District;
  x: number;
  y: number;
  w: number;
  total: number;
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * `dive`: a tall scroll container. While it scrolls past, the camera turns top-down and descends
 * into a single node cell; at progress 1 the cell's black top fills the canvas.
 */
export function ComputeDie({
  className,
  interactive = true,
  focusLocal = false,
  dive,
}: {
  className?: string;
  interactive?: boolean;
  focusLocal?: boolean;
  dive?: RefObject<HTMLElement | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const sim = useSim();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      const THREE = await import("three");
      const { RoundedBoxGeometry } = await import("three/examples/jsm/geometries/RoundedBoxGeometry.js");
      const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");
      if (disposed || !host.current) return;
      const el = host.current;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      } catch {
        setFailed(true);
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.NeutralToneMapping;
      renderer.toneMappingExposure = 1.0;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      el.prepend(renderer.domElement);
      renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";

      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envTex;
      scene.environmentIntensity = 0.55;

      /* ------------------------------------------------------------ floorplan */
      const profiles = getDeviceClasses();
      const districts: District[] = [];
      let first = 0;
      let zCursor = 0;
      let maxW = 0;
      const rowMeta: { z0: number; rows: number; width: number; items: District[] }[] = [];
      for (const row of ROWS) {
        const ps = row.map((id) => profiles.find((p) => p.id === id)!);
        const total = ps.reduce((s, p) => s + p.nodes, 0);
        const rows = Math.ceil(total / (COL_BUDGET - GAP_COLS * (ps.length - 1)));
        let col = 0;
        const items: District[] = [];
        for (const p of ps) {
          const cols = Math.ceil(p.nodes / rows);
          items.push({ id: p.id, label: p.label, nodes: p.nodes, medianScore: p.medianScore, x0: col * PITCH, z0: zCursor, cols, rows, first });
          first += p.nodes;
          col += cols + GAP_COLS;
        }
        const width = (col - GAP_COLS) * PITCH;
        maxW = Math.max(maxW, width);
        rowMeta.push({ z0: zCursor, rows, width, items });
        zCursor += rows * PITCH + ROW_GAP;
      }
      const innerD = zCursor - ROW_GAP;
      const W = maxW + MARGIN * 2;
      const D = innerD + MARGIN * 2;
      // center everything on the origin
      for (const r of rowMeta) {
        const dx = -r.width / 2;
        for (const d of r.items) {
          d.x0 += dx;
          d.z0 -= innerD / 2;
          districts.push(d);
        }
      }
      const busZ = rowMeta[0].z0 - innerD / 2 + rowMeta[0].rows * PITCH + ROW_GAP / 2;
      const TOTAL = first;
      const cellX = new Float32Array(TOTAL);
      const cellZ = new Float32Array(TOTAL);
      const cellD = new Uint8Array(TOTAL);
      districts.forEach((d, di) => {
        for (let i = 0; i < d.nodes; i++) {
          const r = Math.floor(i / d.cols);
          const c = i % d.cols;
          cellX[d.first + i] = d.x0 + (c + 0.5) * PITCH;
          cellZ[d.first + i] = d.z0 + (r + 0.5) * PITCH;
          cellD[d.first + i] = di;
        }
      });

      /* ----------------------------------------------------------------- die */
      const rig = new THREE.Group();
      scene.add(rig);
      const die = new THREE.Group();
      rig.add(die);

      const m4pin = new THREE.Matrix4();
      const body = new THREE.Mesh(
        new RoundedBoxGeometry(W, THICK, D, 6, 0.09),
        new THREE.MeshStandardMaterial({ color: 0x0f1115, roughness: 0.42, metalness: 0.35 }),
      );
      body.position.y = -THICK / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      die.add(body);

      const substrate = new THREE.Mesh(
        new RoundedBoxGeometry(W + SUB_PAD * 2, SUB_THICK, D + SUB_PAD * 2, 6, 0.06),
        new THREE.MeshStandardMaterial({ color: 0xdfe3e9, roughness: 0.72, metalness: 0.02 }),
      );
      substrate.position.y = -THICK - SUB_THICK / 2 + 0.01;
      substrate.castShadow = true;
      substrate.receiveShadow = true;
      die.add(substrate);
      // contact pins along the substrate edge
      const pinGeo = new THREE.BoxGeometry(0.06, 0.02, 0.12);
      const pinMat = new THREE.MeshStandardMaterial({ color: 0x9aa2ad, roughness: 0.35, metalness: 0.8 });
      const pinsPerSide = Math.floor((W + SUB_PAD) / 0.2);
      const pins = new THREE.InstancedMesh(pinGeo, pinMat, pinsPerSide * 2);
      for (let i = 0; i < pinsPerSide; i++) {
        const x = -W / 2 - SUB_PAD / 2 + (i + 0.5) * ((W + SUB_PAD) / pinsPerSide);
        m4pin.makeTranslation(x, -THICK + 0.012, -D / 2 - SUB_PAD + 0.12);
        pins.setMatrixAt(i, m4pin);
        m4pin.makeTranslation(x, -THICK + 0.012, D / 2 + SUB_PAD - 0.12);
        pins.setMatrixAt(pinsPerSide + i, m4pin);
      }
      die.add(pins);

      // etched top surface: district plates, bus lane, pads, markings
      const texW = 2048;
      const texH = Math.round((texW * D) / W);
      const cv = document.createElement("canvas");
      cv.width = texW;
      cv.height = texH;
      const g = cv.getContext("2d")!;
      const sx = (x: number) => ((x + W / 2) / W) * texW;
      const sz = (z: number) => ((z + D / 2) / D) * texH;
      const k = texW / W;
      g.fillStyle = "#121419";
      g.fillRect(0, 0, texW, texH);
      // fine silicon grain
      const grain = g.createImageData(texW, texH);
      for (let i = 0; i < grain.data.length; i += 4) {
        const v = 21 + ((Math.random() * 6) | 0);
        grain.data[i] = v;
        grain.data[i + 1] = v;
        grain.data[i + 2] = v - 1;
        grain.data[i + 3] = 255;
      }
      g.putImageData(grain, 0, 0);
      g.strokeStyle = "rgba(230,233,238,0.09)";
      g.lineWidth = 2;
      g.strokeRect(sx(-W / 2 + 0.16), sz(-D / 2 + 0.16), (W - 0.32) * k, (D - 0.32) * k);
      for (const d of districts) {
        const x = sx(d.x0 - PITCH * 0.6);
        const z = sz(d.z0 - PITCH * 0.6);
        const w = (d.cols + 1.2) * PITCH * k;
        const h = (d.rows + 1.2) * PITCH * k;
        g.fillStyle = "#191c23";
        g.fillRect(x, z, w, h);
        g.strokeStyle = "rgba(230,233,238,0.12)";
        g.lineWidth = 1.5;
        g.strokeRect(x, z, w, h);
      }
      // bus lane
      g.strokeStyle = "rgba(230,233,238,0.16)";
      g.lineWidth = 2;
      g.setLineDash([10, 8]);
      g.beginPath();
      g.moveTo(sx(-W / 2 + 0.3), sz(busZ));
      g.lineTo(sx(W / 2 - 0.3), sz(busZ));
      g.stroke();
      g.setLineDash([]);
      // bond pads along the perimeter
      g.fillStyle = "rgba(230,233,238,0.14)";
      const pad = 0.05 * k;
      for (let x = -W / 2 + 0.4; x < W / 2 - 0.35; x += 0.16) {
        g.fillRect(sx(x), sz(-D / 2 + 0.06), pad, pad * 0.7);
        g.fillRect(sx(x), sz(D / 2 - 0.06) - pad * 0.7, pad, pad * 0.7);
      }
      // IN / OUT pads
      const ioPad = (x: number, label: string, alignRight: boolean) => {
        g.fillStyle = "#3d5afe";
        g.fillRect(sx(x) - 0.07 * k, sz(busZ) - 0.07 * k, 0.14 * k, 0.14 * k);
        g.fillStyle = "rgba(230,233,238,0.55)";
        g.font = `600 ${0.11 * k}px ui-monospace, "JetBrains Mono", monospace`;
        g.textAlign = alignRight ? "right" : "left";
        g.fillText(label, sx(x) + (alignRight ? -0.12 : 0.12) * k, sz(busZ) - 0.1 * k);
      };
      const inX = -W / 2 + 0.2;
      const outX = W / 2 - 0.2;
      ioPad(inX, "IN", false);
      ioPad(outX, "OUT", true);
      // district labels
      g.textAlign = "left";
      for (const d of districts) {
        g.fillStyle = "rgba(230,233,238,0.62)";
        g.font = `600 ${0.13 * k}px ui-monospace, "JetBrains Mono", monospace`;
        g.fillText(d.label, sx(d.x0), sz(d.z0) - 0.07 * k);
        const lw = g.measureText(d.label).width;
        if (getMode() === "demo") {
          g.fillStyle = "rgba(230,233,238,0.32)";
          g.font = `500 ${0.11 * k}px ui-monospace, "JetBrains Mono", monospace`;
          g.fillText(fmtInt(d.nodes), sx(d.x0) + lw + 0.08 * k, sz(d.z0) - 0.07 * k);
        }
      }
      // part marking. Real mode: the grid is a device-class map, not a node count; only real nodes light up.
      g.fillStyle = "rgba(230,233,238,0.3)";
      g.font = `600 ${0.07 * k}px ui-monospace, "JetBrains Mono", monospace`;
      g.textAlign = "right";
      g.fillText(getMode() === "demo" ? `BRAIN·N1  ${fmtInt(TOTAL)} NODES  1 CELL = 1 NODE  SIM` : "BRAIN·N1  DEVICE-CLASS MAP  REAL NODES LIGHT UP", sx(W / 2 - 0.3), sz(D / 2 - 0.16));
      const topTex = new THREE.CanvasTexture(cv);
      topTex.colorSpace = THREE.SRGBColorSpace;
      topTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const top = new THREE.Mesh(
        new THREE.PlaneGeometry(W - 0.02, D - 0.02),
        new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.62, metalness: 0.15 }),
      );
      top.rotation.x = -Math.PI / 2;
      top.position.y = 0.0015;
      top.receiveShadow = true;
      die.add(top);

      /* --------------------------------------------------------------- cells */
      const cellGeo = new THREE.BoxGeometry(PITCH * 0.72, 1, PITCH * 0.72);
      cellGeo.translate(0, 0.5, 0);
      const cellMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.25 });
      const cells = new THREE.InstancedMesh(cellGeo, cellMat, TOTAL);
      cells.castShadow = true;
      cells.receiveShadow = true;
      const baseH = new Float32Array(TOTAL);
      const baseC = new Float32Array(TOTAL);
      const h = new Float32Array(TOTAL);
      const target = new Float32Array(TOTAL);
      const heat = new Float32Array(TOTAL);
      const flash = new Float32Array(TOTAL);
      const flashOk = new Uint8Array(TOTAL);
      const m4 = new THREE.Matrix4();
      const col = new THREE.Color();
      for (let i = 0; i < TOTAL; i++) {
        baseH[i] = 0.012 + Math.random() * 0.01;
        baseC[i] = 0.028 + Math.random() * 0.03;
        h[i] = baseH[i];
        target[i] = baseH[i];
        m4.makeScale(1, baseH[i], 1).setPosition(cellX[i], 0, cellZ[i]);
        cells.setMatrixAt(i, m4);
        col.setRGB(baseC[i], baseC[i], baseC[i] * 0.96);
        cells.setColorAt(i, col);
      }
      die.add(cells);
      const active = new Set<number>();
      let diveCell = -1;
      const touch = (i: number, tgt: number, ht: number) => {
        if (i === diveCell) return;
        target[i] = Math.max(target[i], tgt);
        heat[i] = Math.max(heat[i], ht);
        active.add(i);
      };

      /* --------------------------------------------------------------- halos */
      // Additive glow sprites under cells that are executing or flashing.
      const MAX_HALOS = 420;
      const hc = document.createElement("canvas");
      hc.width = hc.height = 64;
      const hg = hc.getContext("2d")!;
      const hgrad = hg.createRadialGradient(32, 32, 0, 32, 32, 32);
      hgrad.addColorStop(0, "rgba(255,255,255,1)");
      hgrad.addColorStop(0.35, "rgba(255,255,255,0.35)");
      hgrad.addColorStop(1, "rgba(255,255,255,0)");
      hg.fillStyle = hgrad;
      hg.fillRect(0, 0, 64, 64);
      const haloTex = new THREE.CanvasTexture(hc);
      const haloGeo = new THREE.PlaneGeometry(PITCH * 5, PITCH * 5);
      haloGeo.rotateX(-Math.PI / 2);
      const halos = new THREE.InstancedMesh(
        haloGeo,
        new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
        MAX_HALOS,
      );
      halos.frustumCulled = false;
      halos.renderOrder = 2;
      for (let i = 0; i < MAX_HALOS; i++) halos.setColorAt(i, col.setRGB(0, 0, 0));
      halos.count = 0;
      die.add(halos);

      /* -------------------------------------------------------------- pulses */
      const pulseGeo = new THREE.BoxGeometry(PITCH * 1.5, PITCH * 0.9, PITCH * 1.5);
      const pulseMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      const pulseMesh = new THREE.InstancedMesh(pulseGeo, pulseMat, MAX_PULSES * TRAIL);
      pulseMesh.frustumCulled = false;
      const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < MAX_PULSES * TRAIL; i++) {
        pulseMesh.setMatrixAt(i, hidden);
        pulseMesh.setColorAt(i, col.setRGB(1, 1, 1));
      }
      die.add(pulseMesh);
      const pulses: Pulse[] = [];
      const SIGNAL: [number, number, number] = [0.3, 0.42, 1];
      const CHALK: [number, number, number] = [0.86, 0.85, 0.81];
      const OK: [number, number, number] = [0.15, 0.75, 0.42];
      const spawn = (pts: [number, number][], dur: number, color: [number, number, number], done?: () => void) => {
        if (pulses.length >= MAX_PULSES) {
          done?.();
          return;
        }
        const lens: number[] = [];
        let total = 0;
        for (let i = 1; i < pts.length; i++) {
          const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          lens.push(l);
          total += l;
        }
        pulses.push({ pts, lens, total, t0: performance.now(), dur, color, done });
      };
      const at = (p: Pulse, t: number): [number, number] => {
        let d = Math.max(0, Math.min(1, t)) * p.total;
        for (let i = 0; i < p.lens.length; i++) {
          if (d <= p.lens[i] || i === p.lens.length - 1) {
            const u = p.lens[i] ? Math.min(1, d / p.lens[i]) : 1;
            return [p.pts[i][0] + (p.pts[i + 1][0] - p.pts[i][0]) * u, p.pts[i][1] + (p.pts[i + 1][1] - p.pts[i][1]) * u];
          }
          d -= p.lens[i];
        }
        return p.pts[p.pts.length - 1];
      };
      // Manhattan route: pad → bus → column → cell (and back out to OUT)
      const routeIn = (x: number, z: number): [number, number][] => [
        [inX, busZ],
        [x, busZ],
        [x, z],
      ];
      const routeOut = (x: number, z: number): [number, number][] => [
        [x, z],
        [x, busZ],
        [outX, busZ],
      ];

      /* ------------------------------------------------------- live pillars */
      const pillars = new Map<string, { mesh: InstanceType<typeof THREE.Mesh>; ring: InstanceType<typeof THREE.Mesh>; you: boolean; born: number; x: number; z: number; hot: number }>();
      const pillarGeo = new THREE.BoxGeometry(PITCH * 2.2, 1, PITCH * 2.2);
      pillarGeo.translate(0, 0.5, 0);
      const ringGeo = new THREE.RingGeometry(0.9, 1, 48);
      const seatFor = (id: string, dc: DeviceClass) => {
        const d = districts.find((x) => x.id === dc) ?? districts[districts.length - 1];
        const i = d.first + (hash(id) % d.nodes);
        return { x: cellX[i], z: cellZ[i] };
      };
      const labelEls = new Map<string, HTMLDivElement>();
      const syncPillars = () => {
        const s = networkStore.getSnapshot();
        const ids = new Set(Object.keys(s.liveNodes));
        for (const [id, p] of pillars) {
          if (!ids.has(id)) {
            die.remove(p.mesh, p.ring);
            pillars.delete(id);
            labelEls.get(id)?.remove();
            labelEls.delete(id);
          }
        }
        for (const n of Object.values(s.liveNodes)) {
          const you = n.id === s.localNodeId;
          const ex = pillars.get(n.id);
          if (ex) {
            if (ex.you !== you) {
              ex.you = you;
              (ex.mesh.material as InstanceType<typeof THREE.MeshStandardMaterial>).emissive.set(you ? 0x3d5afe : 0x27c46d);
            }
            continue;
          }
          const { x, z } = seatFor(n.id, n.deviceClass);
          const mesh = new THREE.Mesh(
            pillarGeo,
            new THREE.MeshStandardMaterial({ color: you ? 0x3d5afe : 0x27c46d, emissive: you ? 0x3d5afe : 0x27c46d, emissiveIntensity: 0.5, roughness: 0.45 }),
          );
          mesh.position.set(x, 0, z);
          mesh.scale.y = 0.001;
          // Each caster is drawn again in the shadow pass; past a few dozen the shadows are invisible noise anyway.
          mesh.castShadow = you || pillars.size < LABEL_MAX_PILLARS;
          const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: you ? 0x3d5afe : 0x27c46d, transparent: true, opacity: 0, toneMapped: false, side: THREE.DoubleSide }));
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(x, 0.004, z);
          die.add(mesh, ring);
          pillars.set(n.id, { mesh, ring, you, born: performance.now(), x, z, hot: 0 });
          const lab = document.createElement("div");
          lab.className = "die-label";
          labelsRef.current?.appendChild(lab);
          labelEls.set(n.id, lab);
        }
      };

      /* --------------------------------------------------------------- dive */
      // The cell the camera descends into: kept black, framed by an orange rim that locks on.
      const CELL_HALF = PITCH * 0.36;
      const squareRing = (inner: number, outer: number) => {
        const g = new THREE.RingGeometry(inner * Math.SQRT2, outer * Math.SQRT2, 4, 1, Math.PI / 4);
        g.rotateX(-Math.PI / 2);
        return g;
      };
      const rimMat = new THREE.MeshBasicMaterial({ color: 0x3d5afe, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
      const lockMat = rimMat.clone();
      const diveRim = new THREE.Mesh(squareRing(CELL_HALF * 1.12, CELL_HALF * 1.5), rimMat);
      const lock = new THREE.Mesh(squareRing(CELL_HALF * 1.9, CELL_HALF * 2.05), lockMat);
      let diveP = 0;
      let diveE = 0;
      let lockedOn = false;
      if (dive) {
        let best = Infinity;
        const gx = 0.2;
        const gz = busZ + 0.55;
        for (let i = 0; i < TOTAL; i++) {
          const d2 = (cellX[i] - gx) ** 2 + (cellZ[i] - gz) ** 2;
          if (d2 < best) {
            best = d2;
            diveCell = i;
          }
        }
        baseC[diveCell] = 0.004;
        cells.setColorAt(diveCell, col.setRGB(0.004, 0.004, 0.004));
        diveRim.position.set(cellX[diveCell], baseH[diveCell] + 0.0015, cellZ[diveCell]);
        lock.position.copy(diveRim.position);
        die.add(diveRim, lock);
      }

      /* ------------------------------------------------------------- events */
      const runJob = (job: ComputeJob) => {
        const hj = hash(job.id);
        // pick district weighted by node count, then a compact patch of cells = work units
        let r = hj % TOTAL;
        const d = districts.find((x) => r < x.first + x.nodes) ?? districts[0];
        r = (hj >>> 7) % d.nodes;
        const cx0 = r % d.cols;
        const rz0 = Math.floor(r / d.cols);
        const units = Math.max(2, Math.min(12, job.nodeIds.length * 2));
        const picks: number[] = [];
        for (let u = 0; u < units; u++) {
          const c = Math.min(d.cols - 1, Math.max(0, cx0 + ((hash(job.id + u) % 7) - 3)));
          const rr = Math.min(d.rows - 1, Math.max(0, rz0 + ((hash(u + job.id) % 5) - 2)));
          const i = rr * d.cols + c;
          if (i < d.nodes) picks.push(d.first + i);
        }
        if (!picks.length) return;
        const lat = Math.min(job.latencyMs ?? 1200, 2600);
        const hx = cellX[picks[0]];
        const hz = cellZ[picks[0]];
        spawn(routeIn(hx, hz), 520, SIGNAL, () => {
          for (const i of picks) touch(i, 0.09 + Math.random() * 0.14, 1);
          setTimeout(() => {
            for (const i of picks) {
              target[i] = baseH[i];
              heat[i] = 0;
              flash[i] = 1;
              flashOk[i] = 1;
              active.add(i);
            }
            spawn(routeOut(hx, hz), 480, CHALK);
          }, Math.max(250, lat - 520));
        });
      };
      const onEvent = (e: NetworkEvent) => {
        if (!visible) return;
        if (e.type === "job.submitted" && e.job.provenance === "simulated") runJob(e.job);
        else if (e.type === "node.joined" && e.node.provenance === "simulated") {
          const d = districts.find((x) => x.id === e.node.deviceClass) ?? districts[5];
          const i = d.first + (hash(e.node.id) % d.nodes);
          flash[i] = 1;
          flashOk[i] = 2;
          active.add(i);
        }
      };

      let prevJob = "";
      const onContributor = () => {
        const st = contributor.getSnapshot();
        const cur = st.current;
        const me = st.node && pillars.get(st.node.id);
        if (!cur || !me) return;
        const key = cur.id + cur.status;
        if (key === prevJob) return;
        prevJob = key;
        if (cur.status === "received") spawn(routeIn(me.x, me.z), 600, SIGNAL, () => (me.hot = 1));
        else if (cur.status === "computing") me.hot = 1;
        else if (cur.status === "verified" || cur.status === "failed") spawn(routeOut(me.x, me.z), 560, cur.status === "verified" ? OK : SIGNAL);
      };

      /* ------------------------------------------------------- camera/light */
      const camera = new THREE.PerspectiveCamera(30, 1, dive ? 0.003 : 0.1, 200);
      const key = new THREE.DirectionalLight(0xf4f6ff, 2.4);
      key.position.set(-6, 12, 5);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.camera.left = -W;
      key.shadow.camera.right = W;
      key.shadow.camera.top = W;
      key.shadow.camera.bottom = -W;
      key.shadow.bias = -0.0004;
      key.shadow.radius = 6;
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xffffff, 0.6);
      rim.position.set(8, 4, -8);
      scene.add(rim);
      scene.add(new THREE.AmbientLight(0xffffff, 0.25));

      const floor = new THREE.Mesh(new THREE.PlaneGeometry(W * 6, W * 6), new THREE.ShadowMaterial({ opacity: 0.16 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -THICK - SUB_THICK - 0.5;
      floor.receiveShadow = true;
      rig.add(floor);
      // soft contact shadow
      const sc = document.createElement("canvas");
      sc.width = sc.height = 256;
      const sg = sc.getContext("2d")!;
      const grd = sg.createRadialGradient(128, 128, 10, 128, 128, 128);
      grd.addColorStop(0, "rgba(0,0,0,0.42)");
      grd.addColorStop(1, "rgba(0,0,0,0)");
      sg.fillStyle = grd;
      sg.fillRect(0, 0, 256, 256);
      const contact = new THREE.Mesh(new THREE.PlaneGeometry((W + SUB_PAD * 2) * 1.3, (D + SUB_PAD * 2) * 1.45), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
      contact.rotation.x = -Math.PI / 2;
      contact.position.set(0.3, floor.position.y + 0.002, 0.25);
      rig.add(contact);

      die.rotation.y = -0.42;
      let aspect = 1;
      const camDir = new THREE.Vector3();
      const baseTgt = new THREE.Vector3();
      const curTgt = new THREE.Vector3();
      const wantTgt = new THREE.Vector3();
      let baseDist = 0;
      let curDist = 0;
      const fit = () => {
        const r = el.getBoundingClientRect();
        aspect = r.width / Math.max(1, r.height);
        renderer.setSize(r.width, r.height, false);
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
        // Solve framing: project the die's corners and iterate distance + target until the
        // die fills `fillW` of the width (bounded by `fillH`) and sits centered.
        const elev = 0.8;
        const az = -0.12;
        const dir = new THREE.Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev));
        const tgt = new THREE.Vector3(0, -THICK / 2, 0);
        let dist = W * 3;
        // In dive mode the canvas is full-bleed, so the die is framed off-center beside the copy.
        const wide = aspect > 1.15;
        const fillW = dive ? (wide ? 1.02 : 1.62) : 1.9;
        const fillH = dive ? (wide ? 1.12 : 0.8) : 1.62;
        const cxN = dive ? (wide ? 0.43 : 0) : 0;
        const cyN = dive ? (wide ? -0.1 : -0.5) : 0;
        die.updateMatrixWorld(true);
        const corners: InstanceType<typeof THREE.Vector3>[] = [];
        for (const x of [-W / 2 - SUB_PAD, W / 2 + SUB_PAD]) for (const y of [-THICK - SUB_THICK, 0.3]) for (const z of [-D / 2 - SUB_PAD, D / 2 + SUB_PAD]) corners.push(new THREE.Vector3(x, y, z).applyMatrix4(die.matrixWorld));
        const p = new THREE.Vector3();
        const right = new THREE.Vector3();
        const up = new THREE.Vector3();
        for (let it = 0; it < 12; it++) {
          camera.position.copy(tgt).addScaledVector(dir, dist);
          camera.lookAt(tgt);
          camera.updateMatrixWorld(true);
          let x0 = Infinity;
          let x1 = -Infinity;
          let y0 = Infinity;
          let y1 = -Infinity;
          for (const c of corners) {
            p.copy(c).project(camera);
            x0 = Math.min(x0, p.x);
            x1 = Math.max(x1, p.x);
            y0 = Math.min(y0, p.y);
            y1 = Math.max(y1, p.y);
          }
          const s = Math.max((x1 - x0) / fillW, (y1 - y0) / fillH);
          dist *= 0.5 + 0.5 * s;
          // shift target by the NDC offset of the bbox center, in world units at the target depth
          const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist;
          right.setFromMatrixColumn(camera.matrixWorld, 0);
          up.setFromMatrixColumn(camera.matrixWorld, 1);
          tgt.addScaledVector(right, ((x0 + x1) / 2 - cxN) * halfH * aspect * 0.8);
          tgt.addScaledVector(up, ((y0 + y1) / 2 + 0.04 - cyN) * halfH * 0.8);
        }
        camDir.copy(dir);
        baseTgt.copy(tgt);
        baseDist = dist;
        if (!curDist) {
          curTgt.copy(tgt);
          curDist = dist;
        }
      };
      fit();
      const ro = new ResizeObserver(fit);
      ro.observe(el);

      /* -------------------------------------------------------------- input */
      let mx = 0;
      let my = 0;
      let tx = 0;
      let ty = 0;
      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const hit = new THREE.Vector3();
      const inv = new THREE.Matrix4();
      const onMove = (ev: PointerEvent) => {
        const r = el.getBoundingClientRect();
        mx = ((ev.clientX - r.left) / r.width) * 2 - 1;
        my = ((ev.clientY - r.top) / r.height) * 2 - 1;
        if (!interactive) return;
        if (diveP > 0.02) return setHover(null);
        ndc.set(mx, -my);
        ray.setFromCamera(ndc, camera);
        if (!ray.ray.intersectPlane(plane, hit)) return setHover(null);
        inv.copy(die.matrixWorld).invert();
        hit.applyMatrix4(inv);
        const d = districts.find((q) => hit.x >= q.x0 - PITCH && hit.x <= q.x0 + (q.cols + 1) * PITCH && hit.z >= q.z0 - PITCH && hit.z <= q.z0 + (q.rows + 1) * PITCH);
        setHover(d ? { d, x: ev.clientX - r.left, y: ev.clientY - r.top, w: r.width, total: TOTAL } : null);
      };
      const onLeave = () => {
        mx = 0;
        my = 0;
        setHover(null);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerleave", onLeave);

      let visible = true;
      const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
      io.observe(el);

      /* --------------------------------------------------------------- loop */
      const offEvents = networkStore.onEvent(onEvent);
      const offStore = networkStore.subscribe(syncPillars);
      const offContrib = contributor.subscribe(onContributor);
      syncPillars();
      const v3 = new THREE.Vector3();
      let last = performance.now();
      let ambientAcc = 0;
      let raf = 0;
      const frame = () => {
        raf = requestAnimationFrame(frame);
        if (!visible) return;
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const t = now / 1000;

        // camera parallax + slow drift
        const calm = 1 - diveE;
        tx += ((reduced ? 0 : mx * 0.07 * calm) - tx) * 0.05;
        ty += ((reduced ? 0 : my * 0.04 * calm) - ty) * 0.05;
        rig.rotation.y = tx + (reduced ? 0 : Math.sin(t * 0.12) * 0.03 * calm);
        const scrollTilt = reduced || dive ? 0 : clamp01(-el.getBoundingClientRect().top / Math.max(1, el.clientHeight));
        rig.rotation.x = ty - scrollTilt * 0.22;
        die.position.y = reduced ? 0 : Math.sin(t * 0.7) * 0.03 * calm;

        // ambient activity proportional to req/s (each request touches a node briefly)
        const rps = networkStore.getSnapshot().metrics.requestsPerSec;
        ambientAcc += dt * rps * 0.22;
        while (ambientAcc >= 1) {
          ambientAcc -= 1;
          const i = (Math.random() * TOTAL) | 0;
          touch(i, baseH[i] + 0.015 + Math.random() * 0.025, 0.4);
          setTimeout(() => (target[i] = baseH[i]), 300 + Math.random() * 700);
        }

        // cells
        let dirty = false;
        for (const i of active) {
          h[i] += (target[i] - h[i]) * Math.min(1, dt * 9);
          if (target[i] <= baseH[i] + 1e-4) heat[i] *= Math.exp(-dt * 3.2);
          flash[i] *= Math.exp(-dt * 2.6);
          m4.makeScale(1, h[i], 1).setPosition(cellX[i], 0, cellZ[i]);
          cells.setMatrixAt(i, m4);
          const b = baseC[i];
          const hh = heat[i];
          const f = flash[i];
          const fc = flashOk[i] === 1 ? OK : CHALK;
          col.setRGB(
            b + (SIGNAL[0] * 1.25 - b) * hh + fc[0] * f * 1.5,
            b + (SIGNAL[1] * 1.25 - b) * hh + fc[1] * f * 1.5,
            b * 0.96 + (SIGNAL[2] * 1.25 - b) * hh + fc[2] * f * 1.5,
          );
          cells.setColorAt(i, col);
          dirty = true;
          if (hh < 0.01 && f < 0.01 && Math.abs(h[i] - baseH[i]) < 0.0008 && target[i] <= baseH[i] + 1e-4) {
            heat[i] = 0;
            flash[i] = 0;
            h[i] = baseH[i];
            active.delete(i);
          }
        }
        if (dirty) {
          cells.instanceMatrix.needsUpdate = true;
          if (cells.instanceColor) cells.instanceColor.needsUpdate = true;
        }
        let nh = 0;
        for (const i of active) {
          if (nh >= MAX_HALOS) break;
          const g = Math.max(heat[i] * 0.9, flash[i]);
          if (g < 0.06) continue;
          m4.makeScale(0.35 + g * 0.65, 1, 0.35 + g * 0.65).setPosition(cellX[i], h[i] + 0.004, cellZ[i]);
          halos.setMatrixAt(nh, m4);
          const fc = heat[i] * 0.9 >= flash[i] ? SIGNAL : flashOk[i] === 1 ? OK : CHALK;
          halos.setColorAt(nh, col.setRGB(fc[0] * g * 0.55, fc[1] * g * 0.55, fc[2] * g * 0.55));
          nh++;
        }
        halos.count = nh;
        halos.instanceMatrix.needsUpdate = true;
        if (halos.instanceColor) halos.instanceColor.needsUpdate = true;

        // pulses with short trails
        for (let p = pulses.length - 1; p >= 0; p--) {
          const pu = pulses[p];
          const u = (now - pu.t0) / pu.dur;
          if (u >= 1) {
            pulses.splice(p, 1);
            pu.done?.();
          }
        }
        for (let s = 0; s < MAX_PULSES; s++) {
          const pu = pulses[s];
          for (let k2 = 0; k2 < TRAIL; k2++) {
            const idx = s * TRAIL + k2;
            if (!pu) {
              pulseMesh.setMatrixAt(idx, hidden);
              continue;
            }
            const u = (now - pu.t0) / pu.dur - k2 * 0.035;
            if (u < 0) {
              pulseMesh.setMatrixAt(idx, hidden);
              continue;
            }
            const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
            const [px, pz] = at(pu, e);
            const sc2 = 1 - k2 / TRAIL;
            m4.makeScale(sc2, sc2, sc2).setPosition(px, 0.03, pz);
            pulseMesh.setMatrixAt(idx, m4);
            const fade = 0.35 + sc2 * 0.9;
            pulseMesh.setColorAt(idx, col.setRGB(pu.color[0] * fade, pu.color[1] * fade, pu.color[2] * fade));
          }
        }
        pulseMesh.instanceMatrix.needsUpdate = true;
        if (pulseMesh.instanceColor) pulseMesh.instanceColor.needsUpdate = true;

        // live pillars
        const local = networkStore.getSnapshot().localNodeId;
        // One layout read per frame. Reading the host rect inside the loop, right after writing a
        // transform, forced a synchronous layout per live node per frame: with 700 nodes that alone
        // was the page's frame budget.
        const hostRect = labelEls.size ? el.getBoundingClientRect() : null;
        // Everyone's own node is labelled; the rest only while there are few enough to read.
        const showLabels = pillars.size <= LABEL_MAX_PILLARS;
        for (const [id, p] of pillars) {
          const age = (now - p.born) / 1000;
          const grow = Math.min(1, age / 0.9);
          const hBase = p.you ? 0.42 : 0.24;
          p.hot *= Math.exp(-dt * 0.9);
          const busy = p.you && contributor.getSnapshot().current?.status === "computing";
          if (busy) p.hot = Math.max(p.hot, 0.9);
          p.mesh.scale.y = Math.max(0.001, hBase * (1 - Math.pow(1 - grow, 3)) * (1 + p.hot * 0.25 + (p.you ? Math.sin(t * 3) * 0.03 : 0)));
          (p.mesh.material as InstanceType<typeof THREE.MeshStandardMaterial>).emissiveIntensity = 0.45 + p.hot * 0.5;
          const ringT = (age % (p.you ? 2.2 : 3.4)) / (p.you ? 2.2 : 3.4);
          const rs = 0.06 + ringT * (p.you ? 0.75 : 0.4);
          p.ring.scale.set(rs, rs, rs);
          (p.ring.material as InstanceType<typeof THREE.MeshBasicMaterial>).opacity = (1 - ringT) * (p.you ? 0.75 : 0.4) * (age < 6 || p.you ? 1 : 0.4);
          const lab = labelEls.get(id);
          if (lab && hostRect) {
            const you = id === local;
            if (!you && !showLabels) {
              if (lab.style.display !== "none") lab.style.display = "none";
              continue;
            }
            if (lab.style.display === "none") lab.style.display = "";
            v3.set(p.x, p.mesh.scale.y + 0.06, p.z).applyMatrix4(die.matrixWorld).project(camera);
            lab.style.transform = `translate(${((v3.x + 1) / 2) * hostRect.width}px, ${((1 - v3.y) / 2) * hostRect.height}px)`;
            const text = you ? `YOU · NODE ${id}` : `NODE ${id}`;
            if (lab.textContent !== text) {
              lab.textContent = text;
              lab.dataset.you = String(you);
            }
          }
        }

        if (dive) {
          const dr = dive.current?.getBoundingClientRect();
          diveP = dr ? clamp01(-dr.top / Math.max(1, dr.height - window.innerHeight)) : 0;
          diveE = smooth(0.03, 0.78, diveP);
          const ez = Math.pow(smooth(0.05, 1, diveP), 1.4);
          const elev = 0.8 + (1.5 - 0.8) * diveE;
          const az = -0.12 * (1 - diveE);
          die.rotation.y = -0.42 * (1 - diveE);
          die.updateMatrixWorld(true);
          v3.set(cellX[diveCell], baseH[diveCell], cellZ[diveCell]).applyMatrix4(die.matrixWorld);
          wantTgt.copy(baseTgt).lerp(v3, smooth(0.03, 0.62, diveP));
          v3.set(Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev));
          camera.position.copy(wantTgt).addScaledVector(v3, baseDist * Math.pow(0.012 / baseDist, ez));
          camera.lookAt(wantTgt);

          const lockT = smooth(0.14, 0.4, diveP);
          lock.scale.setScalar(1 + (1 - lockT) * 5);
          lockMat.opacity = lockT * (1 - smooth(0.55, 0.75, diveP)) * 0.9;
          rimMat.opacity = smooth(0.3, 0.42, diveP) * (0.75 + Math.sin(t * 5) * 0.25 * (1 - diveE * 0.6));
          if (!lockedOn && diveP > 0.3) {
            lockedOn = true;
            spawn(routeIn(cellX[diveCell], cellZ[diveCell]), 560, SIGNAL);
          } else if (diveP < 0.2) lockedOn = false;
          renderer.render(scene, camera);
          return;
        }

        // camera: framing from fit(), or glide toward your node once it has joined
        const mine = focusLocal && local ? pillars.get(local) : undefined;
        let wantDist = baseDist;
        wantTgt.copy(baseTgt);
        if (mine && (now - mine.born) / 1000 > 0.6) {
          wantTgt.set(mine.x, 0, mine.z).applyMatrix4(die.matrixWorld);
          wantDist = baseDist * 0.46;
        }
        const k3 = Math.min(1, dt * 1.4);
        curTgt.lerp(wantTgt, k3);
        curDist += (wantDist - curDist) * k3;
        camera.position.copy(curTgt).addScaledVector(camDir, curDist);
        camera.lookAt(curTgt);

        renderer.render(scene, camera);
      };
      raf = requestAnimationFrame(frame);

      cleanup = () => {
        cancelAnimationFrame(raf);
        offEvents();
        offStore();
        offContrib();
        ro.disconnect();
        io.disconnect();
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerleave", onLeave);
        labelEls.forEach((l) => l.remove());
        scene.traverse((o) => {
          const m = o as InstanceType<typeof THREE.Mesh>;
          m.geometry?.dispose();
          const mat = m.material as InstanceType<typeof THREE.Material> | undefined;
          mat?.dispose();
        });
        topTex.dispose();
        haloTex.dispose();
        envTex.dispose();
        pmrem.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })().catch(() => setFailed(true));
    return () => {
      disposed = true;
      cleanup();
    };
  }, [interactive, focusLocal, dive, sim]);

  return (
    <div ref={host} className={cx("relative select-none", className)}>
      <div ref={labelsRef} className="pointer-events-none absolute inset-0 overflow-hidden" />
      {failed && <div className="absolute inset-0 grid place-items-center font-mono text-[12px] text-fog">3D view unavailable (WebGL disabled)</div>}
      {hover && sim && (
        <div
          className="pointer-events-none absolute z-10 w-[210px] rounded-xl bg-ink/95 p-3.5 font-mono text-[11.5px] text-chalk shadow-2xl ring-1 ring-chalk/10 backdrop-blur"
          style={{ left: hover.x > hover.w - 240 ? hover.x - 226 : hover.x + 16, top: hover.y + 16 }}
        >
          <div className="flex items-center justify-between">
            <span className="font-semibold">{hover.d.label}</span>
            <span className="rounded-sm px-1 text-[9.5px] text-chalk/45 ring-1 ring-chalk/20">SIM</span>
          </div>
          <div className="mt-2.5 space-y-1 text-chalk/60">
            <div className="flex justify-between">
              <span>nodes</span>
              <span className="text-chalk">{fmtInt(hover.d.nodes)}</span>
            </div>
            <div className="flex justify-between">
              <span>median score</span>
              <span className="text-chalk">{fmtInt(hover.d.medianScore)}</span>
            </div>
            <div className="flex justify-between">
              <span>share of network</span>
              <span className="text-chalk">{((hover.d.nodes / hover.total) * 100).toFixed(1)}%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
