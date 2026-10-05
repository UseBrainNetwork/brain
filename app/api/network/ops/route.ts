import { nodeRoute } from "@/api/http";
import { listOrders, publicOrder } from "@/engine/orders";
import { eventBus } from "@/services/eventBus";
import { snapshot } from "@/services/accounting";
import { listRequests } from "@/services/customers";
import { listJobs, realSummary } from "@/services/distributed";
import { listProfiles } from "@/services/nodeProfile";
import { liveNodes } from "@/services/nodes";
import { listReceipts } from "@/services/receipts";
import { json, sharedJson } from "@/services/security";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

/** Everything the operations view needs, REAL only. */
export const GET = nodeRoute(async () => {
  const [nodes, summary, jobs, receipts, orders, requests, profiles] = await Promise.all([liveNodes(), realSummary(), listJobs(20), listReceipts(20), listOrders(20), listRequests(20), listProfiles(20)]);
  const snap = await snapshot("REAL", 0, undefined, receipts);
  const terminal = jobs.filter((j) => j.status === "completed" || j.status === "failed");
  const observability = {
    jobLatencyMedianMs: median(terminal.map((j) => j.totals.latencyMs ?? 0).filter(Boolean)),
    queueToDistributedMs: median(terminal.map((j) => stage(j, "distributed") - j.createdAt).filter((x) => x >= 0)),
    verificationTailMs: median(terminal.map((j) => (j.completedAt ?? 0) - stage(j, "verifying")).filter((x) => x >= 0)),
    reassignments: jobs.reduce((s, j) => s + j.totals.reassigned, 0),
    failedUnits: jobs.reduce((s, j) => s + j.totals.failed, 0),
    capacityUtilization: nodes.length ? nodes.filter((n) => n.status === "computing").length / nodes.length : null,
  };
  const store = getStore();
  const backend = "kind" in store && typeof (store as { kind?: () => string }).kind === "function" ? (store as { kind: () => string }).kind() : "memory";
  return sharedJson({ source: "REAL", backend, nodes, summary, jobs, receipts, orders: orders.map(publicOrder), requests, profiles, economics: snap, observability, recentEvents: eventBus.history(Date.now() - 15 * 60_000).filter((e) => e.type !== "node.heartbeat").slice(-40).reverse().map(describe) });
});

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
  const nodeId = (e.nodeId as string | undefined) ?? (e.node as { id?: string } | undefined)?.id;
  const unitId = e.unitId as string | undefined;
  let detail = "";
  if (job?.id != null) detail = `job #${job.id}${job.status ? ` · ${job.status}` : ""}${job.totals ? ` · ${job.totals.verified}/${job.totals.units} verified` : ""}`;
  if (unitId) detail = `unit ${unitId}${nodeId ? ` · node ${nodeId}` : ""}`;
  else if (nodeId && !detail) detail = `node ${nodeId}`;
  return { at: e.at, type: e.type, detail };
}
