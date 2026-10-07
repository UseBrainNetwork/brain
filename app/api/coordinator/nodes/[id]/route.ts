import { nodeRoute } from "@/api/http";
import type { AccountingEvent } from "@/domain/economy";
import { pathParam } from "@/services/coordinator/http";
import { listInferenceJobs, publicInferenceJob } from "@/services/coordinator/jobs";
import { getNativeNode, publicNativeNode } from "@/services/coordinator/registry";
import { json } from "@/services/security";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

const TTL_MS = 10_000;
const cache = globalThis as typeof globalThis & { __brainNNodeView?: Map<string, { at: number; value: Promise<unknown> }> };

/**
 * GET /api/coordinator/nodes/<id> — one node's public record, its recent jobs (public view) and
 * what the accounting ledger says it has earned (REAL events only, accrued = owed, settled = paid).
 * "Estimated earnings" on the provider dashboard is exactly `accrued`, never a projection.
 */
async function build(id: string) {
  const now = Date.now();
  const n = await getNativeNode(id);
  if (!n) return null;
  const jobs = (await listInferenceJobs(300)).filter((j) => j.assignedNode === id).slice(0, 50).map(publicInferenceJob);
  const events = (await getStore().listDocs<AccountingEvent>("accounting", { key: "REAL", limit: 5_000 })).filter((e) => e.relatedNodeId === id && e.type === "COMPUTE_PROVIDER_EARNED");
  const earnings = {
    accruedUsd: events.filter((e) => e.settlement === "accrued").reduce((s, e) => s + e.amount, 0),
    settledUsd: events.filter((e) => e.settlement === "settled").reduce((s, e) => s + e.amount, 0),
    events: events.length,
    basis: events.length ? "accrued at list price; nothing has been paid out" : "no priced work yet",
  };
  return { node: publicNativeNode(n, now), jobs, earnings, asOf: now };
}

export const GET = nodeRoute(async (req) => {
  const id = pathParam(req, 1).toUpperCase();
  const m = (cache.__brainNNodeView ??= new Map());
  const now = Date.now();
  let hit = m.get(id);
  if (!hit || now - hit.at > TTL_MS) {
    hit = { at: now, value: build(id) };
    m.set(id, hit);
    hit.value.catch(() => m.delete(id));
  }
  const v = await hit.value;
  return v ? json(v) : json({ error: "not_found" }, 404);
});
