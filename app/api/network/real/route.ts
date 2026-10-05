import { nodeRoute } from "@/api/http";
import { realSummary } from "@/services/distributed";
import { liveNodes } from "@/services/nodes";
import { sharedJson } from "@/services/security";

export const dynamic = "force-dynamic";

/** Polled every 4 s by every viewer; one snapshot per instance per 3 s serves them all. */
const TTL_MS = 3_000;
const st = globalThis as typeof globalThis & { __brainNetReal?: { at: number; body: unknown; inflight: Promise<unknown> | null } };
const cache = (st.__brainNetReal ??= { at: 0, body: null, inflight: null });

async function build() {
  const [nodes, summary] = await Promise.all([liveNodes(), realSummary()]);
  cache.body = { nodes, summary };
  cache.at = Date.now();
  return cache.body;
}

/** REAL MODE snapshot: only devices connected to this server and work it verified. */
export const GET = nodeRoute(async () => {
  if (cache.body && Date.now() - cache.at < TTL_MS) return sharedJson(cache.body, 3);
  cache.inflight ??= build().finally(() => (cache.inflight = null));
  if (cache.body) return sharedJson(cache.body, 3);
  return sharedJson(await cache.inflight, 3);
});
