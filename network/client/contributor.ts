"use client";

import { useSyncExternalStore } from "react";
import type { ComputeJob, ComputeNode, NodeBenchmark, WorkloadKind } from "@/domain/types";
import { networkConfig } from "@/lib/config";
import { walletStore } from "@/lib/wallet/store";
import type { WorkloadSpec } from "@/network/workloads";
import { scorePercentile } from "@/services/mock/mockData";
import { WebGPUBackend } from "@/webgpu/backend";
import { probeThroughput, runChallenge, type BenchmarkProgress } from "@/webgpu/benchmark";
import { detectDevice, type DeviceDetection } from "@/webgpu/detect";
import { networkStore } from "../realtime/store";
import { adoptId, loadIdentity } from "./identity";
import { inferenceWorker } from "./inferenceWorker";

/**
 * The browser node. Owns the full lifecycle:
 * detect → probe → server challenge → register → heartbeat + job loop → leave.
 */

export type Phase =
  | "idle"
  | "detecting"
  | "detected"
  | "unsupported"
  | "benchmarking"
  | "benchmarked"
  | "joining"
  | "running"
  | "stopped"
  | "error";

export interface JobLogEntry {
  id: string;
  kind: WorkloadKind;
  model: string;
  /** Distributed work units: parent job id and unit id (e.g. "5000012-C"). */
  parentId?: string;
  unitId?: string;
  status: "received" | "computing" | "verifying" | "verified" | "failed";
  gpuMs?: number;
  latencyMs?: number;
  units?: number;
  rewardUsd?: number;
  reason?: string;
}

export interface ContributorState {
  phase: Phase;
  detection: DeviceDetection | null;
  bench: (BenchmarkProgress & { samples: number[] }) | null;
  benchmark: (NodeBenchmark & { percentile: number }) | null;
  node: ComputeNode | null;
  startedAt: number | null;
  jobsCompleted: number;
  jobsFailed: number;
  verifiedUnits: number;
  sessionUsd: number;
  todayUsd: number;
  allTimeUsd: number;
  current: JobLogEntry | null;
  log: JobLogEntry[];
  firstJobDone: boolean;
  error: string | null;
  /** Worker mode: only take distributed work units, never filler jobs. Used by /node. */
  workerMode: boolean;
}

const LS_KEY = "brain.earnings.v1";
interface Ledger {
  day: string;
  today: number;
  allTime: number;
}
const today = () => new Date().toISOString().slice(0, 10);
function readLedger(): Ledger {
  try {
    const l = JSON.parse(localStorage.getItem(LS_KEY) ?? "") as Ledger;
    return l.day === today() ? l : { day: today(), today: 0, allTime: l.allTime ?? 0 };
  } catch {
    return { day: today(), today: 0, allTime: 0 };
  }
}

const initial: ContributorState = {
  phase: "idle",
  detection: null,
  bench: null,
  benchmark: null,
  node: null,
  startedAt: null,
  jobsCompleted: 0,
  jobsFailed: 0,
  verifiedUnits: 0,
  sessionUsd: 0,
  todayUsd: 0,
  allTimeUsd: 0,
  current: null,
  log: [],
  firstJobDone: false,
  error: null,
  workerMode: false,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ContributorEngine {
  private state = initial;
  private listeners = new Set<() => void>();
  private backend: WebGPUBackend | null = null;
  private session: string | null = null;
  private running = false;
  private hb: ReturnType<typeof setInterval> | null = null;
  private recovering: Promise<boolean> | false = false;
  private recoveries: number[] = [];
  private wake: (() => void) | null = null;
  private unwatch: (() => void) | null = null;

  constructor() {
    walletStore.sessionToken = () => this.session;
  }

  /** Server-side registration payload for this browser's persistent anonymous identity. */
  private identity() {
    return loadIdentity();
  }

  /**
   * /node: one call does detect → benchmark → join in worker mode. The node then waits for
   * distributed work units instead of pulling filler jobs.
   */
  async joinAsWorker() {
    this.set({ workerMode: true });
    if (this.state.phase === "idle" || this.state.phase === "unsupported" || this.state.phase === "error") await this.detect();
    if (this.state.detection?.webgpu !== "ready") return;
    if (!this.state.benchmark || this.state.phase === "stopped") {
      if (this.state.phase === "stopped") this.reset();
      await this.benchmark();
    }
    if (this.state.phase === "benchmarked") await this.join();
  }

  getSnapshot = () => this.state;
  getServerSnapshot = () => initial;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  private set(p: Partial<ContributorState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  }

  async detect() {
    if (this.state.phase !== "idle" && this.state.phase !== "unsupported" && this.state.phase !== "error") return;
    this.set({ phase: "detecting", error: null });
    const [detection] = await Promise.all([detectDevice(), sleep(900)]);
    const l = readLedger();
    this.set({ detection, phase: detection.webgpu === "ready" ? "detected" : "unsupported", todayUsd: l.today, allTimeUsd: l.allTime });
  }

  async benchmark() {
    const d = this.state.detection;
    if (!d || d.webgpu !== "ready") return;
    this.set({ phase: "benchmarking", bench: { phase: "warmup", progress: 0, samples: [] }, error: null });
    try {
      this.backend ??= await WebGPUBackend.create();
      const samples: number[] = [];
      const onProgress = (p: BenchmarkProgress) => {
        if (p.roundsPerSec) samples.push(p.roundsPerSec);
        this.set({ bench: { ...p, samples: [...samples] } });
      };
      const probe = await probeThroughput(this.backend, onProgress);
      const ch = await postJson<{ challengeId: string; spec: WorkloadSpec }>("/api/benchmark/challenge", { probeRoundsPerSec: probe });
      const { result, gpuMs } = await runChallenge(this.backend, ch.spec, onProgress);
      // The challenge must be answered promptly, so register (standby, not yet broadcast) right away.
      const reg = await postJson<{ sessionToken: string; node: ComputeNode; benchmark: NodeBenchmark }>("/api/nodes/register", {
        challengeId: ch.challengeId,
        result,
        clientGpuMs: gpuMs,
        device: { deviceClass: d.deviceClass, name: d.gpuName.value, maxBufferBytes: d.maxBufferBytes.value },
        identity: this.identity(),
      });
      this.session = reg.sessionToken;
      adoptId(reg.node.id);
      onProgress({ phase: "submitting", progress: 1 });
      this.set({
        phase: "benchmarked",
        node: reg.node,
        benchmark: { ...reg.benchmark, percentile: scorePercentile(reg.benchmark.computeScore ?? 0) },
      });
      this.startHeartbeat();
    } catch (e) {
      this.set({ phase: "error", error: e instanceof Error ? e.message : "Benchmark failed" });
    }
  }

  /** THE moment: the node becomes visible to the network and starts taking jobs. */
  async join() {
    if (!this.session || !this.state.node || this.running) return;
    this.set({ phase: "joining" });
    let node: ComputeNode;
    try {
      ({ node } = await postJson<{ node: ComputeNode }>("/api/nodes/join", { linkToken: walletStore.linkToken }, this.session));
    } catch (e) {
      this.set({ phase: "error", error: e instanceof Error ? e.message : "join_failed" });
      return;
    }
    networkStore.setLocalNode(node.id);
    // The server broadcasts this join over SSE; ingesting the identical event locally
    // (deduplicated by node id + joinedAt) makes the counter tick instantly regardless of stream latency.
    networkStore.ingest({ type: "node.joined", at: node.joinedAt, node });
    this.set({ node });
    if (!this.state.workerMode) await sleep(1600);
    this.running = true;
    this.set({ phase: "running", startedAt: Date.now() });
    this.watchAssignments();
    void this.loop();
    // Inference side: load a model stage and serve hops. Reads the session token lazily so it
    // survives re-registration. Off on phones unless the user opts in.
    void inferenceWorker.start(() => this.session, this.state.detection?.maxBufferBytes.value ?? 0);
  }

  /** Wake the poll loop the instant the server assigns this node a work unit. */
  private watchAssignments() {
    if (this.unwatch) return;
    this.unwatch = networkStore.onEvent((e) => {
      const me = this.state.node?.id;
      if (!me) return;
      const forMe =
        ((e.type === "djob.assigned" || e.type === "work.reassigned") && e.job.units.some((u) => u.nodeId === me && u.status === "assigned")) ||
        (e.type === "work.reassigned" && e.toNodeId === me);
      if (forMe) this.wake?.();
    });
  }

  private waitForWork(ms: number) {
    return new Promise<void>((resolve) => {
      let t: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
      t = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private startHeartbeat() {
    if (this.hb) return;
    this.hb = setInterval(async () => {
      if (!this.session) return;
      try {
        const { node } = await postJson<{ node: ComputeNode }>("/api/nodes/heartbeat", {}, this.session);
        this.set({ node: { ...node, status: this.running ? "computing" : node.status } });
      } catch (e) {
        if (e instanceof Error && e.message === "banned") this.halt(e.message);
        else if (e instanceof Error && e.message === "unauthorized" && !(await this.recover())) this.halt(e.message);
      }
    }, networkConfig.nodes.heartbeatMs);
    window.addEventListener("pagehide", this.leaveBeacon);
  }

  private leaveBeacon = () => {
    if (!this.session) return;
    fetch("/api/nodes/leave", { method: "POST", keepalive: true, headers: { authorization: `Bearer ${this.session}` } }).catch(() => {});
  };

  private async loop() {
    let first = !this.state.workerMode;
    while (this.running && this.backend && this.session) {
      try {
        const worker = this.state.workerMode;
        const { job, retryMs, build } = await postJson<{
          job: { id: string; kind: WorkloadKind; model: string; spec: WorkloadSpec; units: number; parentId?: string; unitId?: string } | null;
          retryMs?: number;
          build?: string | null;
        }>("/api/jobs/next", { distributedOnly: worker }, this.session);
        if (!job) {
          // Nothing assigned: idle until the server announces work for us, or for as long as it told us to.
          if (this.state.current) this.set({ current: null });
          // A newer client is deployed: keep polling, reload at this idle point once the jitter has passed.
          if (worker && this.outdated(build) && this.upgrade()) return;
          await this.waitForWork(Math.min(30_000, Math.max(3500, retryMs ?? 0)));
          continue;
        }
        const entry: JobLogEntry = { id: job.id, kind: job.kind, model: job.model, parentId: job.parentId, unitId: job.unitId, status: "received" };
        this.set({ current: entry });
        if (!worker) await sleep(first ? 1100 : 1500);
        if (job.parentId) await postJson("/api/jobs/start", { jobId: job.id }, this.session).catch(() => {});

        this.set({ current: { ...entry, status: "computing" } });
        const t0 = performance.now();
        const { result, gpuMs } = await this.backend.execute(job.spec);
        // Pacing below exists only for /contribute's first-job reveal. Worker mode never pads.
        const minShow = first ? 1200 : 0;
        const spent = performance.now() - t0;
        if (spent < minShow) await sleep(minShow - spent);

        this.set({ current: { ...entry, status: "verifying", gpuMs } });
        const res = await postJson<{ verified: boolean; units: number; latencyMs: number; estRewardUsd: number; reason?: string; node: ComputeNode; job: ComputeJob }>(
          "/api/jobs/result",
          { jobId: job.id, result, clientGpuMs: gpuMs },
          this.session,
        );
        if (first) await sleep(500);

        const done: JobLogEntry = {
          ...entry,
          status: res.verified ? "verified" : "failed",
          gpuMs,
          latencyMs: res.latencyMs,
          units: res.units,
          rewardUsd: res.estRewardUsd,
          reason: res.reason,
        };
        const ledger = readLedger();
        ledger.today += res.estRewardUsd;
        ledger.allTime += res.estRewardUsd;
        localStorage.setItem(LS_KEY, JSON.stringify(ledger));

        networkStore.ingest({ type: "job.completed", at: Date.now(), job: res.job });
        if (res.verified) networkStore.ingest({ type: "node.verified", at: Date.now(), nodeId: res.node.id, units: res.units, jobId: res.job.id });

        const s = this.state;
        this.set({
          node: { ...res.node, status: "computing" },
          current: done,
          log: [done, ...s.log].slice(0, 40),
          jobsCompleted: s.jobsCompleted + (res.verified ? 1 : 0),
          jobsFailed: s.jobsFailed + (res.verified ? 0 : 1),
          verifiedUnits: s.verifiedUnits + res.units,
          sessionUsd: s.sessionUsd + res.estRewardUsd,
          todayUsd: ledger.today,
          allTimeUsd: ledger.allTime,
          firstJobDone: true,
        });
        first = false;
        if (!worker) await sleep(1400);
        else {
          // Let the VERIFIED state be visible on the device before the next unit, unless more is queued.
          await sleep(700);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "error";
        if (msg === "banned") return this.halt(msg);
        if (msg === "unauthorized") {
          if (!(await this.recover())) return this.halt(msg);
          continue;
        }
        await sleep(3000);
      }
    }
  }

  /** The build id the server reported when this tab first polled. */
  private build: string | null | undefined;

  /**
   * True once the server is answering from a different deployment than the one this tab loaded.
   * The first build seen is taken as "ours": the bundle itself does not know its own id.
   */
  private outdated(build: string | null | undefined): boolean {
    if (!build) return false;
    if (this.build === undefined) {
      this.build = build;
      return false;
    }
    return build !== this.build;
  }

  /**
   * Reload into the new client at an idle moment, as a worker that rejoins by itself. Jittered so
   * a deploy does not make the whole fleet re-download its model stage in the same second.
   */
  private upgradeAt = 0;
  private upgrade(): boolean {
    if (!this.upgradeAt) this.upgradeAt = Date.now() + 2_000 + Math.random() * 45_000;
    if (Date.now() < this.upgradeAt) return false;
    const url = new URL(window.location.href);
    url.searchParams.set("autostart", "1");
    window.location.replace(url.toString());
    return true;
  }

  /**
   * The server no longer knows this session (it restarted, or a different serverless instance
   * answered). Re-run the challenge, register and rejoin without user action. Bounded so a
   * persistently failing server doesn't loop forever.
   */
  private async recover(): Promise<boolean> {
    const d = this.state.detection;
    if (!this.backend || !d) return false;
    if (this.recovering) return this.recovering;
    const now = Date.now();
    this.recoveries = this.recoveries.filter((t) => now - t < 10 * 60_000);
    if (this.recoveries.length >= 5) return false;
    this.recoveries.push(now);
    this.recovering = (async () => {
      try {
        const probe = this.state.bench?.samples.at(-1);
        const ch = await postJson<{ challengeId: string; spec: WorkloadSpec }>("/api/benchmark/challenge", { probeRoundsPerSec: probe });
        const { result, gpuMs } = await runChallenge(this.backend!, ch.spec, () => {});
        const reg = await postJson<{ sessionToken: string; node: ComputeNode }>("/api/nodes/register", {
          challengeId: ch.challengeId,
          result,
          clientGpuMs: gpuMs,
          device: { deviceClass: d.deviceClass, name: d.gpuName.value, maxBufferBytes: d.maxBufferBytes.value },
          identity: this.identity(),
        });
        this.session = reg.sessionToken;
        adoptId(reg.node.id);
        if (!this.running) {
          this.set({ node: reg.node });
          return true;
        }
        const { node } = await postJson<{ node: ComputeNode }>("/api/nodes/join", { linkToken: walletStore.linkToken }, this.session);
        networkStore.setLocalNode(node.id);
        networkStore.ingest({ type: "node.joined", at: node.joinedAt, node });
        this.set({ node: { ...node, status: "computing" } });
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => (this.recovering = false), 0);
      }
    })();
    return this.recovering;
  }

  private halt(reason: string) {
    this.running = false;
    void inferenceWorker.stop("off");
    this.unwatch?.();
    this.unwatch = null;
    this.wake?.();
    if (this.hb) clearInterval(this.hb);
    this.hb = null;
    this.set({ phase: "error", error: reason, current: null });
  }

  async stop() {
    this.running = false;
    void inferenceWorker.stop("off");
    this.unwatch?.();
    this.unwatch = null;
    this.wake?.();
    if (this.hb) clearInterval(this.hb);
    this.hb = null;
    if (this.session) {
      await postJson("/api/nodes/leave", {}, this.session).catch(() => {});
      if (this.state.node) networkStore.ingest({ type: "node.left", at: Date.now(), nodeId: this.state.node.id, memoryGb: this.state.node.advertisedMemoryGb });
    }
    window.removeEventListener("pagehide", this.leaveBeacon);
    this.session = null;
    networkStore.setLocalNode(null);
    this.set({ phase: "stopped", current: null, node: this.state.node ? { ...this.state.node, status: "offline" } : null });
  }

  reset() {
    this.set({ ...initial, workerMode: this.state.workerMode, detection: this.state.detection, phase: this.state.detection?.webgpu === "ready" ? "detected" : "idle" });
  }
}

async function postJson<T>(url: string, body: unknown, bearer?: string | null): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : `http_${r.status}`);
  return j as T;
}

const g = globalThis as typeof globalThis & { __brainNode?: ContributorEngine };
export const contributor = (g.__brainNode ??= new ContributorEngine());

export function useContributor(): ContributorState {
  return useSyncExternalStore(contributor.subscribe, contributor.getSnapshot, contributor.getServerSnapshot);
}
