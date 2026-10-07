import { nodeRoute } from "@/api/http";
import { nodeEconomics, nodeProfile } from "@/services/nodeProfile";
import { publicJob } from "@/services/nodes";
import { json } from "@/services/security";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

/**
 * Every open node tab asks for its own profile every so often. Building it reads a few hundred job
 * rows plus the open-epoch dry run, which is far too much to do per request: this one route was most
 * of the database's load. Each instance keeps the answer for five minutes per node.
 */
const TTL_MS = 5 * 60_000;
const cache = globalThis as typeof globalThis & { __brainNodeView?: Map<string, { at: number; value: Promise<unknown | null> }> };

async function build(id: string) {
  // 60 recent rows are enough for median latency and reassignment rate; 200 full JSON rows per tab per
  // poll was the single largest load on the database (433k calls, 192 ms each).
  const jobs = await getStore().listJobsForNode(id, 60);
  const profile = await nodeProfile(id, Date.now(), jobs);
  if (!profile) return null;
  const economics = await nodeEconomics(id, Date.now(), jobs);
  return { profile, jobs: jobs.slice(0, 25).map(publicJob), economics };
}

/** Public reputation profile + recent (secret-free) job records for one anonymous node. */
export const GET = nodeRoute(async (req) => {
  const id = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "").toUpperCase();
  const m = (cache.__brainNodeView ??= new Map());
  const now = Date.now();
  let hit = m.get(id);
  if (!hit || now - hit.at > TTL_MS) {
    const value = build(id);
    hit = { at: now, value };
    m.set(id, hit);
    value.catch(() => m.delete(id));
    if (m.size > 5_000) for (const [k, v] of m) if (now - v.at > TTL_MS) m.delete(k);
  }
  const view = await hit.value;
  if (!view) return json({ error: "not_found" }, 404);
  return json(view, { headers: { "Cache-Control": "private, max-age=30" } });
});
