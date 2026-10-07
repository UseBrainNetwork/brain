"use client";

import { useSyncExternalStore } from "react";
import { fmtUsdSmall } from "@/lib/format";
import type { ComputeNode, DistributedJob, NetworkEvent } from "@/domain/types";
import { NOTIFY_EVERY_MS, networkStore } from "./store";

/**
 * REAL-ONLY view of the network for /demo and /node. Nothing simulated is ever ingested here:
 * nodes come from the server's registry, jobs from the distributed-job orchestrator, and every
 * number is reconciled against /api/network/real every few seconds.
 */

export interface RealSummary {
  source: "real";
  realNodes: number;
  capacityScore: number;
  verifiedComputeUnits: number;
  jobsCompleted: number;
  workUnitsVerified: number;
  successRate: number | null;
}

export interface RealFeedItem {
  key: string;
  at: number;
  title: string;
  detail: string;
  tone: "neutral" | "ok" | "warn" | "bad" | "signal";
}

export interface RealState {
  nodes: Record<string, ComputeNode>;
  /** Most recent first. */
  jobs: DistributedJob[];
  summary: RealSummary | null;
  feed: RealFeedItem[];
  heartbeats: Record<string, number>;
  connected: boolean;
}

const initial: RealState = { nodes: {}, jobs: [], summary: null, feed: [], heartbeats: {}, connected: false };

class RealStore {
  private state = initial;
  private listeners = new Set<() => void>();
  private stop: (() => void) | null = null;
  private seq = 0;

  getSnapshot = () => this.state;
  getServerSnapshot = () => initial;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    this.start();
    return () => {
      this.listeners.delete(l);
    };
  };

  private notifyScheduled = false;
  /** Apply now, notify at most every NOTIFY_EVERY_MS (see NetworkStore.set for why). */
  private set(p: Partial<RealState>) {
    this.state = { ...this.state, ...p };
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    const flush = () => {
      this.notifyScheduled = false;
      this.listeners.forEach((l) => l());
    };
    setTimeout(flush, NOTIFY_EVERY_MS);
  }

  private start() {
    if (this.stop || typeof window === "undefined") return;
    const off = networkStore.onEvent((e) => this.ingest(e));
    const poll = setInterval(() => void this.refresh(), 4000);
    this.stop = () => {
      off();
      clearInterval(poll);
    };
    void this.refresh(true);
  }

  async refresh(withJobs = false) {
    try {
      const r = await fetch("/api/network/real", { cache: "no-store" });
      if (!r.ok) {
        // 503 while the database is unreachable: keep what we have, show as not live.
        if (this.state.connected) this.set({ connected: false });
        return;
      }
      const { nodes, summary, stale } = (await r.json()) as { nodes: ComputeNode[]; summary: RealSummary; stale?: boolean };
      const map: Record<string, ComputeNode> = {};
      for (const n of nodes) map[n.id] = n;
      this.set({ nodes: map, summary, connected: !stale });
      if (withJobs) {
        const j = await fetch("/api/jobs?limit=5", { cache: "no-store" });
        if (j.ok) this.set({ jobs: ((await j.json()) as { jobs: DistributedJob[] }).jobs });
      }
    } catch {
      this.set({ connected: false });
    }
  }

  private push(at: number, title: string, detail: string, tone: RealFeedItem["tone"] = "neutral") {
    this.set({ feed: [{ key: `${at}-${this.seq++}`, at, title, detail, tone }, ...this.state.feed].slice(0, 60) });
  }

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 600);
  }

  private upsertJob(job: DistributedJob) {
    this.set({ jobs: [job, ...this.state.jobs.filter((j) => j.id !== job.id)].slice(0, 5) });
  }

  private ingest(e: NetworkEvent) {
    const s = this.state;
    switch (e.type) {
      case "node.joined":
        if (e.node.provenance !== "live") return;
        this.set({ nodes: { ...s.nodes, [e.node.id]: e.node } });
        this.push(e.at, `NODE ${e.node.id} JOINED`, `+${e.node.computeScore.toLocaleString("en-US")} COMPUTE`, "ok");
        break;
      case "node.left": {
        if (!s.nodes[e.nodeId]) return;
        const { [e.nodeId]: _gone, ...rest } = s.nodes;
        this.set({ nodes: rest });
        this.push(e.at, `NODE ${e.nodeId} ${e.reason === "lost" ? "LOST" : "LEFT"}`, e.reason === "lost" ? "heartbeat timeout" : "disconnected", "warn");
        break;
      }
      case "node.heartbeat":
        // Nothing on the page reads per-node heartbeat times; the 4 s poll carries lastHeartbeatAt.
        // Copying the whole node map here, once per node per 10 s, was O(nodes²) work for nothing.
        break;
      case "node.verified":
        if (!s.nodes[e.nodeId] || e.jobId?.includes("-")) return; // distributed units are reported via work.verified
        this.push(e.at, `NODE ${e.nodeId} VERIFIED`, `+${e.units} COMPUTE UNITS`, "ok");
        break;
      case "djob.created":
        this.upsertJob(e.job);
        this.push(e.at, `JOB #${e.job.id} CREATED`, `${e.job.totals.workUnits} work units · ${e.job.workload.label}`, "signal");
        break;
      case "djob.assigned":
        this.upsertJob(e.job);
        this.push(e.at, `WORK DISTRIBUTED`, `${e.job.units.length} units → ${e.job.nodeIds.length} real nodes`, "signal");
        break;
      case "work.started":
        this.upsertJob(e.job);
        break;
      case "work.completed":
        this.upsertJob(e.job);
        break;
      case "work.verified": {
        this.upsertJob(e.job);
        const u = e.job.units.find((x) => x.id === e.unitId);
        this.push(e.at, `UNIT ${u?.label ?? e.unitId} VERIFIED`, `NODE ${e.nodeId} · +${e.units} units · ${u?.verification?.method ?? ""}`, "ok");
        // Server-authoritative credit is already recorded; bump the live counter optimistically and resync.
        if (s.summary) this.set({ summary: { ...s.summary, verifiedComputeUnits: s.summary.verifiedComputeUnits + e.units, workUnitsVerified: s.summary.workUnitsVerified + 1 } });
        this.scheduleRefresh();
        break;
      }
      case "work.failed": {
        this.upsertJob(e.job);
        const u = e.job.units.find((x) => x.id === e.unitId);
        this.push(e.at, `UNIT ${u?.label ?? e.unitId} ${e.reason === "lost" ? "LOST" : "MISMATCH"}`, `NODE ${e.nodeId} · ${e.reason}`, "bad");
        break;
      }
      case "work.reassigned": {
        this.upsertJob(e.job);
        const u = e.job.units.find((x) => x.id === e.unitId);
        this.push(e.at, `UNIT ${u?.label ?? e.unitId} REASSIGNED`, `NODE ${e.fromNodeId} → NODE ${e.toNodeId}`, "warn");
        break;
      }
      case "djob.completed":
        this.upsertJob(e.job);
        this.push(e.at, `JOB #${e.job.id} COMPLETE`, `${e.job.totals.verified}/${e.job.totals.workUnits} verified · ${((e.job.totals.latencyMs ?? 0) / 1000).toFixed(2)}s`, "ok");
        void this.refresh();
        break;
      case "djob.failed":
        this.upsertJob(e.job);
        this.push(e.at, `JOB #${e.job.id} FAILED`, e.job.failReason ?? "", "bad");
        break;
      // Money lines. Every one of these is a REAL ledger write on the server; SIM never reaches this bus.
      case "order.updated":
        if (e.order.status === "COMPLETED" || e.order.status === "FAILED" || e.order.status === "REJECTED") this.push(e.at, `ORDER ${e.order.orderId.slice(0, 10)} ${e.order.status}`, `${e.order.workload} · ${e.order.mode}${e.order.privacy ? ` · ${e.order.privacy}` : ""}${e.order.error ? ` · ${e.order.error.slice(0, 60)}` : ""}`, e.order.status === "COMPLETED" ? "ok" : "bad");
        break;
      case "receipt.issued":
        this.push(e.at, `RECEIPT ${e.receipt.receiptId.slice(0, 14)}`, `${e.receipt.route?.target ?? "direct"} · ${e.receipt.customerCost ? fmtUsdSmall(e.receipt.customerCost.amount) : "cost UNKNOWN"} · ${e.receipt.verificationMethod}`, e.receipt.verifiedWorkUnits > 0 ? "ok" : "neutral");
        break;
      case "accounting.recorded": {
        const a = e.event;
        if (a.source !== "REAL") return;
        const who = a.type === "COMPUTE_PROVIDER_EARNED" ? `NODE ${a.relatedNodeId ?? "?"} earned` : a.type === "CUSTOMER_PAYMENT" ? "customer owes" : a.type === "PROTOCOL_REVENUE" ? "protocol keeps" : a.type === "INFRASTRUCTURE_COST" ? "infrastructure cost" : a.type === "SUBSCRIPTION_PAYMENT" ? "subscription paid" : "creator reward";
        this.push(e.at, `${a.type.replace(/_/g, " ")}`, `${who} ${a.currency === "USD" ? fmtUsdSmall(a.amount) : `${a.amount} SOL`} · ${a.settlement}`, a.type === "COMPUTE_PROVIDER_EARNED" ? "ok" : "signal");
        break;
      }
    }
  }
}

const g = globalThis as typeof globalThis & { __brainReal?: RealStore };
export const realStore = (g.__brainReal ??= new RealStore());

export function useReal<T>(select: (s: RealState) => T): T {
  return useSyncExternalStore(
    realStore.subscribe,
    () => select(realStore.getSnapshot()),
    () => select(realStore.getServerSnapshot()),
  );
}

/** Raw event tap scoped to real events, for packet animations. */
export function onRealEvent(l: (e: NetworkEvent) => void) {
  return networkStore.onEvent((e) => {
    if (e.type === "node.joined" && e.node.provenance !== "live") return;
    if ((e.type === "job.submitted" || e.type === "job.completed") && e.job.provenance !== "live") return;
    if (e.type === "pool.status" || e.type === "metrics") return;
    l(e);
  });
}
