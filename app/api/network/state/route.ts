import { liveNodes, publicJob } from "@/services/nodes";
import { sharedJson } from "@/services/security";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

/** One snapshot per instance per 5 s; every page load in between shares it instead of re-reading the store. */
const TTL_MS = 5_000;
const st = globalThis as typeof globalThis & { __brainNetState?: { at: number; body: unknown; inflight: Promise<unknown> | null } };
const cache = (st.__brainNetState ??= { at: 0, body: null, inflight: null });

async function build() {
  const [nodes, jobs] = await Promise.all([liveNodes(), getStore().listRecentJobs(20)]);
  cache.body = { provenance: "live", nodes, jobs: jobs.map(publicJob) };
  cache.at = Date.now();
  return cache.body;
}

/** Real server-side state only. Simulated network data is never served from here. */
export async function GET() {
  if (cache.body && Date.now() - cache.at < TTL_MS) return sharedJson(cache.body, 3);
  cache.inflight ??= build().finally(() => (cache.inflight = null));
  if (cache.body) return sharedJson(cache.body, 3); // serve the previous snapshot while this one builds
  return sharedJson(await cache.inflight, 3);
}
