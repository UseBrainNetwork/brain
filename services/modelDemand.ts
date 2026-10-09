import "server-only";
import type { ComputeOrder } from "@/domain/economy";
import { MODEL_ALLOWLIST } from "@/node/models";
import { getStore } from "@/services/store";

/**
 * Demand per model over a window, from the orders customers actually placed. This is the signal an
 * operator reads before pinning a model: how often it was asked for, how often a node served it,
 * and how often nothing could (REJECTED = no eligible target, FAILED = every attempt failed).
 *
 * Only allowlisted native model ids are counted; brain/* aliases are routing choices, not demand
 * for a specific model. Counts are counts of orders; nothing is extrapolated.
 */
export interface ModelDemand {
  model: string;
  asked: number;
  served: number;
  unserved: number;
  /** Median wall time of served orders in ms; null until one was served. */
  p50Ms: number | null;
}

export const DEMAND_WINDOW_MS = 24 * 3_600_000;
const SCAN_LIMIT = 5_000;

export function demandFromOrders(orders: Pick<ComputeOrder, "model" | "status" | "createdAt" | "completedAt">[]): ModelDemand[] {
  const ids = new Set(MODEL_ALLOWLIST.filter((m) => !m.mock).map((m) => m.id));
  const acc = new Map<string, { asked: number; served: number; unserved: number; ms: number[] }>();
  for (const o of orders) {
    if (!ids.has(o.model)) continue;
    const a = acc.get(o.model) ?? { asked: 0, served: 0, unserved: 0, ms: [] };
    a.asked++;
    if (o.status === "COMPLETED") {
      a.served++;
      if (o.completedAt) a.ms.push(o.completedAt - o.createdAt);
    } else if (o.status === "REJECTED" || o.status === "FAILED") a.unserved++;
    acc.set(o.model, a);
  }
  return [...acc.entries()]
    .map(([model, a]) => {
      const s = [...a.ms].sort((x, y) => x - y);
      return { model, asked: a.asked, served: a.served, unserved: a.unserved, p50Ms: s.length ? s[Math.floor(s.length / 2)] : null };
    })
    .sort((x, y) => y.asked - x.asked);
}

export async function modelDemand(windowMs = DEMAND_WINDOW_MS, now = Date.now()): Promise<{ windowMs: number; from: number; truncated: boolean; models: ModelDemand[] }> {
  const from = now - windowMs;
  const orders = await getStore().listDocs<ComputeOrder>("order", { from, limit: SCAN_LIMIT });
  return { windowMs, from, truncated: orders.length >= SCAN_LIMIT, models: demandFromOrders(orders) };
}
