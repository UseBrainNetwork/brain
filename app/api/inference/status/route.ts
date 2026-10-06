import { nodeRoute } from "@/api/http";
import { withTimeout } from "@/lib/async";
import { inferenceStatus } from "@/services/inference";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

const cache = globalThis as typeof globalThis & { __brainInfStatus?: { at: number; value: Promise<Awaited<ReturnType<typeof inferenceStatus>>> } };
const TTL_MS = 4_000;

/** Public: network inference capacity per stage and recent session stats. Live data only. */
export const GET = nodeRoute(async () => {
  const now = Date.now();
  if (!cache.__brainInfStatus || now - cache.__brainInfStatus.at > TTL_MS) {
    const value = inferenceStatus();
    cache.__brainInfStatus = { at: now, value };
    value.catch(() => (cache.__brainInfStatus = undefined));
  }
  const status = await withTimeout(cache.__brainInfStatus.value, 8_000, null);
  if (!status) return json({ error: "store_slow" }, 503);
  return json(status);
});
