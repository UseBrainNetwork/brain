import { randomUUID } from "node:crypto";
import { withTimeout } from "@/lib/async";
import { getStore } from "@/services/store";

/**
 * Measured provider performance. Every estimate the router shows is derived from these samples
 * (or from operator configuration). No sample ⇒ UNKNOWN.
 */
export interface ProviderSample {
  id: string;
  providerId: string;
  at: number;
  latencyMs: number;
  ok: boolean;
  /** Request units (compute units or tokens) the sample covered. */
  units: number;
  error?: string;
}

export async function recordSample(s: Omit<ProviderSample, "id">) {
  const row: ProviderSample = { id: randomUUID(), ...s };
  await getStore().putDoc("metric", row.id, row, { at: row.at, key: row.providerId });
  return row;
}

export interface ProviderStats {
  samples: number;
  medianLatencyMs: number | null;
  lastLatencyMs: number | null;
  /** ok / total over the window, null without samples. */
  reliability: number | null;
  lastError?: string;
  lastAt?: number;
}

const EMPTY: ProviderStats = { samples: 0, medianLatencyMs: null, lastLatencyMs: null, reliability: null };
const STATS_TTL_MS = 20_000;
const STATS_READ_TIMEOUT_MS = 1_200;
const statsCache = new Map<string, { at: number; value: ProviderStats }>();

/**
 * Recent samples → stats. Cached per instance for 20 s and bounded to 2.5 s of store time: routing
 * must not stall on bookkeeping. On a slow store the estimate is UNKNOWN, which the router handles.
 */
export async function providerStats(providerId: string, limit = 50): Promise<ProviderStats> {
  const hit = statsCache.get(providerId);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.value;
  const read = readStats(providerId, limit).then((v) => {
    statsCache.set(providerId, { at: Date.now(), value: v });
    return v;
  });
  return withTimeout(
    read.catch(() => hit?.value ?? EMPTY),
    STATS_READ_TIMEOUT_MS,
    hit?.value ?? EMPTY,
  );
}

async function readStats(providerId: string, limit: number): Promise<ProviderStats> {
  const rows = await getStore().listDocs<ProviderSample>("metric", { key: providerId, limit });
  if (!rows.length) return EMPTY;
  const ok = rows.filter((r) => r.ok);
  const lat = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const med = lat.length ? (lat.length % 2 ? lat[lat.length >> 1] : (lat[lat.length / 2 - 1] + lat[lat.length / 2]) / 2) : null;
  const lastFail = rows.find((r) => !r.ok);
  return { samples: rows.length, medianLatencyMs: med, lastLatencyMs: ok[0]?.latencyMs ?? null, reliability: ok.length / rows.length, lastError: lastFail?.error, lastAt: rows[0].at };
}
