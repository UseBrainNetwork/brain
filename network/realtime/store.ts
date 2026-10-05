"use client";

import { useSyncExternalStore } from "react";
import type { ComputeJob, ComputeNode, ModelPool, NetworkEvent, NetworkMetrics } from "@/domain/types";
import { getBaselineMetrics, getModelPools } from "@/services/data";
import { defaultRevenueSplit } from "@/rewards/config";
import { getMode, onModeChange } from "./mode";
import { createSources } from "./sources";

export interface FeedItem {
  key: string;
  at: number;
  verb: "JOINED" | "LEFT" | "COMPLETED" | "VERIFIED" | "ACTIVE" | "LATENCY";
  subject: string;
  value: string;
  live: boolean;
  you: boolean;
}

export interface NetworkState {
  metrics: NetworkMetrics;
  liveNodes: Record<string, ComputeNode>;
  localNodeId: string | null;
  feed: FeedItem[];
  jobs: ComputeJob[];
  pools: ModelPool[];
  connected: boolean;
}

const baseline = getBaselineMetrics();
const initial: NetworkState = {
  metrics: baseline,
  liveNodes: {},
  localNodeId: null,
  feed: [],
  jobs: [],
  pools: getModelPools(),
  connected: false,
};

type Listener = () => void;

class NetworkStoreImpl {
  private state: NetworkState = initial;
  private listeners = new Set<Listener>();
  private eventListeners = new Set<(e: NetworkEvent) => void>();
  private stop: (() => void) | null = null;
  private seen = new Set<string>();
  private simNodeDelta = 0;
  private simMemDelta = 0;

  getSnapshot = () => this.state;
  getServerSnapshot = () => initial;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    this.start();
    return () => {
      this.listeners.delete(l);
    };
  };

  /** Raw event tap for visualizations that animate individual events. */
  onEvent(l: (e: NetworkEvent) => void) {
    this.eventListeners.add(l);
    this.start();
    return () => {
      this.eventListeners.delete(l);
    };
  }

  private set(patch: Partial<NetworkState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  private start() {
    if (this.stop || typeof window === "undefined") return;
    const unsubs = createSources().map((s) => s.connect((e) => this.ingest(e)));
    const ticker = setInterval(() => this.tick(), 1000);
    const offMode = onModeChange(() => this.recompute());
    this.stop = () => {
      unsubs.forEach((u) => u());
      clearInterval(ticker);
      offMode();
    };
    void this.hydrate();
  }

  /** REAL MODE: anything simulated is dropped before it can touch state or the feed. */
  private simulated(e: NetworkEvent): boolean {
    switch (e.type) {
      case "node.joined":
        return e.node.provenance !== "live";
      case "node.left":
        return !this.state.liveNodes[e.nodeId];
      case "job.submitted":
      case "job.completed":
        return e.job.provenance !== "live";
      case "pool.status":
      case "metrics":
        return true;
      default:
        return false;
    }
  }

  private async hydrate() {
    try {
      const r = await fetch("/api/network/state", { cache: "no-store" });
      if (!r.ok) return;
      const { nodes, jobs } = (await r.json()) as { nodes: ComputeNode[]; jobs: ComputeJob[] };
      const liveNodes = { ...this.state.liveNodes };
      for (const n of nodes) liveNodes[n.id] = n;
      this.set({ liveNodes, jobs: [...jobs, ...this.state.jobs].slice(0, 80), connected: true });
      this.recompute();
    } catch {
      /* offline: simulated feed continues */
    }
  }

  setLocalNode(id: string | null) {
    this.set({ localNodeId: id, feed: this.state.feed.map((f) => ({ ...f, you: f.you || (id != null && f.subject.includes(id)) })) });
  }

  /** Single entry point for every event, from any source. Idempotent. */
  ingest = (e: NetworkEvent) => {
    const key = eventKey(e);
    if (key) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
      if (this.seen.size > 4000) this.seen = new Set([...this.seen].slice(-2000));
    }
    if (getMode() === "real" && this.simulated(e)) return;
    this.eventListeners.forEach((l) => l(e));
    const s = this.state;
    const you = (id: string) => id === s.localNodeId;

    switch (e.type) {
      case "node.joined": {
        const live = e.node.provenance === "live";
        if (live) this.set({ liveNodes: { ...s.liveNodes, [e.node.id]: e.node } });
        else {
          this.simNodeDelta++;
          this.simMemDelta += e.node.advertisedMemoryGb;
        }
        this.push({
          key: key ?? `${e.at}`,
          at: e.at,
          verb: "JOINED",
          subject: `NODE ${e.node.id}`,
          value: live ? `+${e.node.computeScore.toLocaleString("en-US")} COMPUTE` : `+${e.node.advertisedMemoryGb} GB`,
          live,
          you: you(e.node.id),
        });
        break;
      }
      case "node.left": {
        const wasLive = Boolean(s.liveNodes[e.nodeId]);
        if (wasLive) {
          const { [e.nodeId]: _gone, ...rest } = s.liveNodes;
          this.set({ liveNodes: rest });
        } else {
          this.simNodeDelta--;
          this.simMemDelta -= e.memoryGb;
        }
        this.push({ key: key ?? `${e.at}`, at: e.at, verb: "LEFT", subject: `NODE ${e.nodeId}`, value: `-${e.memoryGb} GB`, live: wasLive, you: you(e.nodeId) });
        break;
      }
      case "node.verified":
        this.push({
          key: key ?? `${e.at}`,
          at: e.at,
          verb: "VERIFIED",
          subject: `NODE ${e.nodeId}`,
          value: `+${e.units} COMPUTE UNITS`,
          live: Boolean(s.liveNodes[e.nodeId]) || you(e.nodeId),
          you: you(e.nodeId),
        });
        break;
      case "job.submitted":
        this.set({ jobs: [e.job, ...s.jobs.filter((j) => j.id !== e.job.id)].slice(0, 80) });
        break;
      case "job.completed": {
        this.set({ jobs: [e.job, ...s.jobs.filter((j) => j.id !== e.job.id)].slice(0, 80) });
        const mine = e.job.nodeIds.some(you);
        if (e.job.provenance === "live" || Math.random() < 0.55) {
          this.push({
            key: key ?? `${e.at}`,
            at: e.at,
            verb: "COMPLETED",
            subject: `NODE ${e.job.nodeIds[0]}`,
            value: `JOB #${e.job.id}`,
            live: e.job.provenance === "live",
            you: mine,
          });
        }
        if (e.job.provenance === "simulated" && Math.random() < 0.12) {
          this.push({ key: `lat-${e.job.id}`, at: e.at, verb: "LATENCY", subject: `JOB #${e.job.id}`, value: `${((e.job.latencyMs ?? 0) / 1000).toFixed(1)}s`, live: false, you: false });
        }
        break;
      }
      case "pool.status":
        this.set({ pools: s.pools.map((p) => (p.id === e.poolId ? { ...p, nodes: e.nodes } : p)) });
        break;
      case "metrics":
        this.set({ metrics: { ...s.metrics, ...e.patch } });
        break;
    }
    if (e.type === "node.joined" || e.type === "node.left") this.recompute();
  };

  private push(item: FeedItem) {
    this.set({ feed: [item, ...this.state.feed].slice(0, 40) });
  }

  private recompute() {
    const live = Object.values(this.state.liveNodes);
    const liveMem = live.reduce((s, n) => s + n.advertisedMemoryGb, 0);
    if (getMode() === "real") {
      this.set({
        metrics: {
          ...this.state.metrics,
          gpusOnline: live.length,
          availableMemoryTb: liveMem / 1000,
          liveNodes: live.length,
          inferencesToday: 0,
          requestsPerSec: 0,
          creatorRewardsTodayUsd: 0,
          paidToProvidersTodayUsd: 0,
          capacityScore: live.reduce((s, n) => s + n.computeScore, 0),
          provenance: "live",
        },
        feed: this.state.feed.filter((f) => f.live),
        jobs: this.state.jobs.filter((j) => j.provenance === "live"),
      });
      return;
    }
    // DEMO: blend the simulated baseline back in. Counters that real mode zeroed restart from the baseline.
    const m = this.state.metrics;
    this.set({
      metrics: {
        ...m,
        gpusOnline: baseline.gpusOnline + this.simNodeDelta + live.length,
        availableMemoryTb: baseline.availableMemoryTb + (this.simMemDelta + liveMem) / 1000,
        liveNodes: live.length,
        inferencesToday: m.inferencesToday || baseline.inferencesToday,
        requestsPerSec: m.requestsPerSec || baseline.requestsPerSec,
        creatorRewardsTodayUsd: m.creatorRewardsTodayUsd || baseline.creatorRewardsTodayUsd,
        paidToProvidersTodayUsd: m.paidToProvidersTodayUsd || baseline.paidToProvidersTodayUsd,
        capacityScore: baseline.capacityScore,
        provenance: baseline.provenance,
      },
    });
  }

  /** DEMO drift: counters advance at the simulated request rate. Never in real mode. */
  private tick() {
    if (getMode() === "real") return;
    const m = this.state.metrics;
    if (Math.random() < 0.15) {
      const pools = this.state.pools.map((p) => ({ ...p, nodes: Math.max(1, p.nodes + Math.round((Math.random() - 0.5) * 6)) }));
      this.set({ pools });
    }
    const rps = Math.round(baseline.requestsPerSec * (0.93 + Math.random() * 0.14));
    const creator = m.creatorRewardsTodayUsd + Math.random() * 0.9;
    this.set({
      metrics: {
        ...m,
        requestsPerSec: rps,
        inferencesToday: m.inferencesToday + rps,
        creatorRewardsTodayUsd: creator,
        paidToProvidersTodayUsd: m.paidToProvidersTodayUsd + (creator - m.creatorRewardsTodayUsd) * defaultRevenueSplit.creatorRewards.contributors,
      },
    });
  }
}

function eventKey(e: NetworkEvent): string | null {
  switch (e.type) {
    case "node.joined":
      return `j:${e.node.provenance}:${e.node.id}:${e.node.joinedAt}`;
    case "node.left":
      return `l:${e.nodeId}:${e.at}`;
    case "node.verified":
      return e.jobId ? `v:${e.jobId}` : `v:${e.nodeId}:${e.at}`;
    case "job.completed":
      return `c:${e.job.id}`;
    case "job.submitted":
      return `s:${e.job.id}`;
    default:
      return null;
  }
}

const g = globalThis as typeof globalThis & { __brainNet?: NetworkStoreImpl };
export const networkStore = (g.__brainNet ??= new NetworkStoreImpl());

export function useNetwork<T>(select: (s: NetworkState) => T): T {
  return useSyncExternalStore(
    networkStore.subscribe,
    () => select(networkStore.getSnapshot()),
    () => select(networkStore.getServerSnapshot()),
  );
}
