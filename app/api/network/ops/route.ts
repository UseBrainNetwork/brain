import { nodeRoute } from "@/api/http";
import type { ComputeOrder, ComputeReceipt, CustomerRequestRecord, EconomicsSnapshot, NodeReputation } from "@/domain/economy";
import type { ComputeNode, DistributedJob } from "@/domain/types";
import { listOrders, publicOrder } from "@/engine/orders";
import { withTimeout } from "@/lib/async";
import { eventBus } from "@/services/eventBus";
import { snapshot } from "@/services/accounting";
import { listRequests } from "@/services/customers";
import { listJobs, realSummary } from "@/services/distributed";
import { listProfiles } from "@/services/nodeProfile";
import { publicNode } from "@/services/nodes";
import { listReceipts } from "@/services/receipts";
import { sharedJson } from "@/services/security";
import { getStore, type StoredNode } from "@/services/store";
import { networkConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

type Summary = Awaited<ReturnType<typeof realSummary>>;

interface Sections {
  nodes: ComputeNode[];
  summary: Summary | null;
  jobs: DistributedJob[];
  receipts: ComputeReceipt[];
  orders: ReturnType<typeof publicOrder>[];
  requests: CustomerRequestRecord[];
  profiles: NodeReputation[];
  economics: EconomicsSnapshot | null;
}

interface Ops extends Sections {
  source: "REAL";
  backend: string;
  /** When the records were read. Clients compare against now to show staleness. */
  asOf: number;
  /** Sections whose read timed out or failed on this refresh. Values shown for them are the last good read, or empty. */
  degraded: (keyof Sections)[];
  observability: { jobLatencyMedianMs: number | null; queueToDistributedMs: number | null; verificationTailMs: number | null; reassignments: number; failedUnits: number; capacityUtilization: number | null };
  recentEvents: { at: number; type: string; detail: string }[];
}

/** Each section gets this long against the store before the last good value is used instead. */
const SECTION_BUDGET_MS = 6_000;
/** A fresh snapshot is built at most this often per instance; everyone polling in between shares it. */
const TTL_MS = 8_000;

const state = globalThis as typeof globalThis & { __brainOps?: { last: Ops | null; good: Partial<Sections>; inflight: Promise<Ops> | null } };
const st = (state.__brainOps ??= { last: null, good: {}, inflight: null });

/**
 * Everything the operations view needs, REAL only. The store is the bottleneck for this page: one
 * build used to issue ~50 queries and every viewer polled it every 3 s. Now one node scan feeds four
 * sections, profiles skip the per-node job scan, and the whole snapshot is shared across viewers
 * for a few seconds. A slow section is reported as degraded instead of rendering as "nothing yet".
 */
export const GET = nodeRoute(async () => {
  const now = Date.now();
  if (st.last && now - st.last.asOf < TTL_MS) return sharedJson(st.last, 3);
  st.inflight ??= build().finally(() => (st.inflight = null));
  // If a build is already running and we have something to show, do not make this viewer wait for it.
  if (st.last) return sharedJson({ ...st.last, recentEvents: events() }, 3);
  return sharedJson(await st.inflight, 3);
});

async function build(): Promise<Ops> {
  const store = getStore();
  const degraded: (keyof Sections)[] = [];

  // One node scan for liveNodes, summary, profiles and utilization.
  const scanned = await withTimeout(store.listNodes().catch(() => null), SECTION_BUDGET_MS, null);
  const allNodes: StoredNode[] | null = scanned;
  const nowMs = Date.now();
  const isLive = (n: StoredNode) => (n.status === "idle" || n.status === "computing") && nowMs - n.lastHeartbeatAt <= networkConfig.nodes.offlineAfterMs;

  const section = async <K extends keyof Sections>(key: K, read: () => Promise<Sections[K]>, empty: Sections[K]): Promise<Sections[K]> => {
    const v = await withTimeout(read().catch(() => undefined), SECTION_BUDGET_MS, undefined);
    if (v === undefined) {
      degraded.push(key);
      return (st.good[key] as Sections[K] | undefined) ?? empty;
    }
    st.good[key] = v;
    return v;
  };

  let nodes: ComputeNode[];
  let profiles: NodeReputation[];
  if (allNodes) {
    nodes = st.good.nodes = allNodes.filter(isLive).map(publicNode);
    profiles = st.good.profiles = await listProfiles(20, { light: true, nodes: allNodes });
  } else {
    degraded.push("nodes", "profiles");
    nodes = st.good.nodes ?? [];
    profiles = st.good.profiles ?? [];
  }
  const [summary, jobs, receipts, orders, requests] = await Promise.all([
    section("summary", () => realSummary(allNodes ?? undefined), null),
    section("jobs", () => listJobs(20), []),
    section("receipts", () => listReceipts(20), []),
    section("orders", async () => (await listOrders(20)).map(publicOrder), []),
    section("requests", () => listRequests(20), []),
  ]);
  const economics = await section("economics", () => snapshot("REAL", 0, undefined, receipts), null);

  const terminal = jobs.filter((j) => j.status === "completed" || j.status === "failed");
  const observability = {
    jobLatencyMedianMs: median(terminal.map((j) => j.totals.latencyMs ?? 0).filter(Boolean)),
    queueToDistributedMs: median(terminal.map((j) => stage(j, "distributed") - j.createdAt).filter((x) => x >= 0)),
    verificationTailMs: median(terminal.map((j) => (j.completedAt ?? 0) - stage(j, "verifying")).filter((x) => x >= 0)),
    reassignments: jobs.reduce((s, j) => s + j.totals.reassigned, 0),
    failedUnits: jobs.reduce((s, j) => s + j.totals.failed, 0),
    capacityUtilization: nodes.length ? nodes.filter((n) => n.status === "computing").length / nodes.length : null,
  };
  const backend = "kind" in store && typeof (store as { kind?: () => string }).kind === "function" ? (store as { kind: () => string }).kind() : "memory";
  const ops: Ops = { source: "REAL", backend, asOf: Date.now(), degraded, nodes, summary, jobs, receipts, orders, requests, profiles, economics, observability, recentEvents: events() };
  st.last = ops;
  return ops;
}

function events() {
  return eventBus
    .history(Date.now() - 15 * 60_000)
    .filter((e) => e.type !== "node.heartbeat" && e.type !== "njob.progress")
    .slice(-40)
    .reverse()
    .map(describe);
}

function stage(j: { lifecycle: { stage: string; at: number }[] }, s: string) {
  return j.lifecycle.find((l) => l.stage === s)?.at ?? -1;
}
function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** Compact, client-safe description of a bus event (no payload bodies). */
function describe(e: { type: string; at: number } & Record<string, unknown>) {
  const job = e.job as { id?: string | number; status?: string; totals?: { verified: number; units: number } } | undefined;
  const nodeId = (e.nodeId as string | undefined) ?? (e.node as { id?: string; nodeId?: string } | undefined)?.id ?? (e.node as { nodeId?: string } | undefined)?.nodeId;
  const unitId = e.unitId as string | undefined;
  let detail = "";
  if (e.type === "njob.updated") {
    const nj = e.job as { jobId: string; state: string; model: string; assignedNode: string | null };
    return { at: e.at, type: e.type, detail: `${nj.model} · ${nj.state}${nj.assignedNode ? ` · ${nj.assignedNode}` : ""}` };
  }
  if (e.type === "nnode.updated") return { at: e.at, type: e.type, detail: `${nodeId} · ${String(e.change)} · ${(e.node as { state: string }).state}` };
  if (e.type === "njob.progress") return { at: e.at, type: e.type, detail: `${nodeId} · ${String(e.outputChars)} chars` };
  if (job?.id != null) detail = `job #${job.id}${job.status ? ` · ${job.status}` : ""}${job.totals ? ` · ${job.totals.verified}/${job.totals.units} verified` : ""}`;
  if (unitId) detail = `unit ${unitId}${nodeId ? ` · node ${nodeId}` : ""}`;
  else if (nodeId && !detail) detail = `node ${nodeId}`;
  return { at: e.at, type: e.type, detail };
}
