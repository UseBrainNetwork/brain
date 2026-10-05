import { randomUUID } from "node:crypto";
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

export async function providerStats(providerId: string, limit = 50): Promise<ProviderStats> {
  const rows = await getStore().listDocs<ProviderSample>("metric", { key: providerId, limit });
  if (!rows.length) return { samples: 0, medianLatencyMs: null, lastLatencyMs: null, reliability: null };
  const ok = rows.filter((r) => r.ok);
  const lat = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const med = lat.length ? (lat.length % 2 ? lat[lat.length >> 1] : (lat[lat.length / 2 - 1] + lat[lat.length / 2]) / 2) : null;
  const lastFail = rows.find((r) => !r.ok);
  return { samples: rows.length, medianLatencyMs: med, lastLatencyMs: ok[0]?.latencyMs ?? null, reliability: ok.length / rows.length, lastError: lastFail?.error, lastAt: rows[0].at };
}
