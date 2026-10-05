/**
 * DEMO network activity generator. Deterministic per job number so the explorer can
 * render any simulated job's detail page. Everything produced here is provenance "simulated".
 */
import type { ComputeJob, DeviceClass, JobLifecycleEvent, WorkloadKind } from "@/domain/types";
import { mulberry32 } from "@/network/workloads";
import { deviceClasses, modelPools } from "./mockData";

export const FIRST_SIM_JOB = 918_200;
/** Real jobs are numbered from 5,000,001 (services/store.ts). */
export const isSimulatedJobId = (id: string) => Number(id) < 5_000_000;

export const hexId = (rnd: () => number) => (rnd() & 0xffff).toString(16).toUpperCase().padStart(4, "0");

const kinds: { kind: WorkloadKind; pool: string; model: string; latency: [number, number]; units: [number, number]; shards: [number, number] }[] = [
  { kind: "inference", pool: "qwen-32b", model: "brain/qwen", latency: [700, 2400], units: [12, 40], shards: [4, 9] },
  { kind: "inference", pool: "deepseek-distill", model: "brain/code", latency: [900, 2900], units: [14, 44], shards: [4, 8] },
  { kind: "embedding", pool: "embeddings", model: "brain/embed", latency: [80, 260], units: [2, 6], shards: [1, 3] },
  { kind: "verification", pool: "verification", model: "verify/canary", latency: [180, 420], units: [3, 7], shards: [2, 3] },
  { kind: "inference", pool: "vision", model: "brain/vision", latency: [1400, 3600], units: [20, 60], shards: [3, 6] },
];
const kindWeights = [0.38, 0.17, 0.27, 0.13, 0.05];

const range = (rnd: () => number, [a, b]: [number, number]) => a + (rnd() % (b - a + 1));

export function mockDeviceClass(rnd: () => number): DeviceClass {
  const total = deviceClasses.reduce((s, d) => s + d.nodes, 0);
  let r = rnd() % total;
  for (const d of deviceClasses) if ((r -= d.nodes) < 0) return d.id;
  return "OTHER_WEBGPU";
}

export function mockJob(num: number, submittedAt: number): ComputeJob {
  const rnd = mulberry32(num * 2654435761);
  let pick = (rnd() % 1000) / 1000;
  let idx = 0;
  while (idx < kindWeights.length - 1 && (pick -= kindWeights[idx]) > 0) idx++;
  const k = kinds[idx];
  const shards = range(rnd, k.shards);
  const latencyMs = range(rnd, k.latency);
  const nodeIds = Array.from({ length: shards }, () => hexId(rnd));
  const t = submittedAt;
  const f = (x: number) => Math.round(t + latencyMs * x);
  const lifecycle: JobLifecycleEvent[] = [
    { stage: "submitted", at: t },
    { stage: "split", at: f(0.04), detail: `${shards} work units` },
    { stage: "assigned", at: f(0.09), detail: nodeIds.join(" · ") },
    { stage: "executing", at: f(0.14) },
    { stage: "verifying", at: f(0.86), detail: rnd() % 4 === 0 ? "redundant ×2" : "spot-check" },
    { stage: "merged", at: f(0.95) },
    { stage: "completed", at: f(1) },
  ];
  return {
    id: String(num),
    model: k.model,
    kind: k.kind,
    status: "completed",
    nodeIds,
    workUnits: shards,
    computeUnits: range(rnd, k.units),
    latencyMs,
    submittedAt,
    lifecycle,
    provenance: "simulated",
  };
}

export const poolForModel = (model: string) => modelPools.find((p) => p.model === model)?.id;
