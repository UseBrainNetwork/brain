import type { CreatorRewardTreasury, Source } from "@/domain/economy";
import { record } from "./accounting";
import { getStore } from "./store";

/**
 * Creator-reward treasury: what has arrived from Pump.fun creator fees and what has been
 * allocated/distributed to contributors.
 *
 * Adapters:
 *   MockCreatorRewardAdapter    SIMULATED numbers for the demo site. Never enters REAL totals.
 *   ManualCreatorRewardAdapter  operator records a real receipt by hand with a tx signature.
 *   PumpFunCreatorRewardAdapter NOT IMPLEMENTED: no on-chain reader is wired; it reports so.
 */

export interface CreatorRewardAdapter {
  readonly name: CreatorRewardTreasury["adapter"];
  readonly source: Source;
  /** Returns newly observed receipts (SOL) since the last call, with references. */
  poll(): Promise<{ amountSol: number; reference: string; at: number }[]>;
  status(): { ok: boolean; detail: string };
}

export class MockCreatorRewardAdapter implements CreatorRewardAdapter {
  readonly name = "mock" as const;
  readonly source = "SIMULATED" as const;
  async poll() {
    return [];
  }
  status() {
    return { ok: true, detail: "simulated treasury for demo mode; produces no real events" };
  }
}

export class ManualCreatorRewardAdapter implements CreatorRewardAdapter {
  readonly name = "manual" as const;
  readonly source = "REAL" as const;
  private queue: { amountSol: number; reference: string; at: number }[] = [];
  /** Operator-authenticated route pushes here; see app/api/treasury/route.ts. */
  add(amountSol: number, reference: string, at = Date.now()) {
    if (!(amountSol > 0) || !/^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(reference)) throw new Error("manual adapter: amount must be > 0 and reference a Solana signature");
    this.queue.push({ amountSol, reference, at });
  }
  async poll() {
    const out = this.queue;
    this.queue = [];
    return out;
  }
  status() {
    return { ok: true, detail: "operator records receipts with a transaction signature" };
  }
}

export class PumpFunCreatorRewardAdapter implements CreatorRewardAdapter {
  readonly name = "pumpfun" as const;
  readonly source = "REAL" as const;
  async poll(): Promise<never[]> {
    return [];
  }
  status() {
    return { ok: false, detail: "not implemented: requires BRAIN_TOKEN_MINT + an on-chain creator-fee reader. Nothing is scraped or guessed." };
  }
}

const g = globalThis as typeof globalThis & { __brainManualAdapter?: ManualCreatorRewardAdapter };
export const manualAdapter = (g.__brainManualAdapter ??= new ManualCreatorRewardAdapter());

const EMPTY = (source: Source, adapter: CreatorRewardTreasury["adapter"]): CreatorRewardTreasury => ({ balance: 0, received: 0, allocated: 0, distributed: 0, pendingDistribution: 0, currency: "SOL", source, adapter, updatedAt: 0, references: [] });

export async function getTreasury(source: Source = "REAL"): Promise<CreatorRewardTreasury> {
  const t = await getStore().getDoc<CreatorRewardTreasury>("treasury", source);
  return t ?? EMPTY(source, source === "REAL" ? "manual" : "mock");
}

/** Pulls new receipts from the real adapter into the ledger. Idempotent per reference. */
export async function syncTreasury(adapter: CreatorRewardAdapter = manualAdapter): Promise<CreatorRewardTreasury> {
  const store = getStore();
  const t = await getTreasury(adapter.source);
  for (const r of await adapter.poll()) {
    if (t.references.includes(r.reference)) continue;
    await record({ type: "CREATOR_REWARD_RECEIVED", amount: r.amountSol, currency: "SOL", timestamp: r.at, source: adapter.source, settlement: "settled", transactionReference: r.reference, note: `${adapter.name} adapter` });
    t.received += r.amountSol;
    t.balance += r.amountSol;
    t.references.push(r.reference);
  }
  t.adapter = adapter.name;
  t.updatedAt = Date.now();
  await store.putDoc("treasury", adapter.source, t, { at: t.updatedAt, key: adapter.source });
  return t;
}

/** Moves balance → allocated when an epoch is finalized against the treasury. */
export async function allocateFromTreasury(amountSol: number, epochId: string): Promise<CreatorRewardTreasury> {
  const store = getStore();
  const t = await getTreasury("REAL");
  if (amountSol > t.balance + 1e-12) throw new Error("treasury: allocation exceeds balance");
  t.balance -= amountSol;
  t.allocated += amountSol;
  t.pendingDistribution += amountSol;
  t.updatedAt = Date.now();
  t.references.push(`epoch:${epochId}`);
  await store.putDoc("treasury", "REAL", t, { at: t.updatedAt, key: "REAL" });
  return t;
}

export function adapterStatuses() {
  return [new MockCreatorRewardAdapter(), manualAdapter, new PumpFunCreatorRewardAdapter()].map((a) => ({ name: a.name, source: a.source, ...a.status() }));
}
