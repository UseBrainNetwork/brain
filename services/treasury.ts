import type { CreatorRewardTreasury, Source } from "@/domain/economy";
import { protocolWallet, token } from "@/lib/site";
import { record } from "./accounting";
import { readTransfer, rpc as solanaCall, rpcUrl as solanaRpc } from "./solana";
import { getStore } from "./store";

/**
 * Creator-reward treasury: what has arrived from Pump.fun creator fees and what has been
 * allocated/distributed to contributors.
 *
 * Adapters:
 *   MockCreatorRewardAdapter    SIMULATED numbers for the demo site. Never enters REAL totals.
 *   ManualCreatorRewardAdapter  operator records a real receipt by hand with a tx signature.
 *   PumpFunCreatorRewardAdapter reads the chain: every transaction where SOL left one of our pump.fun
 *                               creator-fee vault PDAs and landed in the protocol wallet is a receipt,
 *                               keyed by its signature. Nothing is estimated; unclaimed fees still in the
 *                               vault are shown separately and never enter the ledger until claimed.
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

interface PumpCursor {
  /** Newest signature fully processed. Scans stop here next time. */
  signature: string;
  at: number;
}

const POLL_MIN_INTERVAL_MS = 60_000;
const POLL_PAGE = 50;

export class PumpFunCreatorRewardAdapter implements CreatorRewardAdapter {
  readonly name = "pumpfun" as const;
  readonly source = "REAL" as const;
  private lastPollAt = 0;
  private lastError: string | null = null;

  enabled() {
    return Boolean(token.mint) && Boolean(protocolWallet.address);
  }

  /**
   * Walks signatures for the protocol wallet newest→oldest until the saved cursor, reads each transaction
   * oldest→newest and emits creator-fee claims. The cursor only advances past transactions that were read,
   * so an RPC hiccup delays a receipt rather than dropping it. Throttled to one chain scan per minute.
   */
  async poll() {
    if (!this.enabled()) return [];
    const now = Date.now();
    if (now - this.lastPollAt < POLL_MIN_INTERVAL_MS) return [];
    this.lastPollAt = now;
    const store = getStore();
    const cursor = await store.getDoc<PumpCursor>("treasury", "pumpfun:cursor");
    const { url } = solanaRpc();
    const out: { amountSol: number; reference: string; at: number }[] = [];
    try {
      const sigs = await solanaCall<{ signature: string; blockTime: number | null; err: unknown }[]>(url, "getSignaturesForAddress", [
        protocolWallet.address,
        { limit: POLL_PAGE, commitment: "confirmed", ...(cursor ? { until: cursor.signature } : {}) },
      ]);
      let newest: PumpCursor | null = null;
      for (const s of [...sigs].reverse()) {
        if (s.err) {
          newest = { signature: s.signature, at: now };
          continue;
        }
        const t = await readTransfer(url, protocolWallet.address, s.signature, s.blockTime);
        if (t && t.creatorFeeSol > 0) out.push({ amountSol: t.creatorFeeSol, reference: t.signature, at: t.at ?? now });
        newest = { signature: s.signature, at: now };
      }
      if (newest) await store.putDoc("treasury", "pumpfun:cursor", newest, { at: now, key: "pumpfun:cursor" });
      this.lastError = null;
    } catch (e) {
      // Partial progress is kept by the caller (receipts are idempotent per signature); the cursor is not advanced.
      this.lastError = e instanceof Error ? e.message : "rpc error";
    }
    return out;
  }

  status() {
    if (!this.enabled()) return { ok: false, detail: "waiting for BRAIN_TOKEN_MINT; nothing is scraped or guessed" };
    return {
      ok: true,
      detail: this.lastError
        ? `on-chain reader: last scan failed (${this.lastError}); receipts resume next scan`
        : `reads creator-fee claims from pump.fun vaults into ${protocolWallet.address.slice(0, 4)}…${protocolWallet.address.slice(-4)} by transaction signature`,
    };
  }
}

const g = globalThis as typeof globalThis & { __brainManualAdapter?: ManualCreatorRewardAdapter; __brainPumpAdapter?: PumpFunCreatorRewardAdapter };
export const manualAdapter = (g.__brainManualAdapter ??= new ManualCreatorRewardAdapter());
export const pumpAdapter = (g.__brainPumpAdapter ??= new PumpFunCreatorRewardAdapter());

/** Pulls any new on-chain creator-fee claims into the REAL ledger, then returns it. Safe to call on every read. */
export async function syncedTreasury(): Promise<CreatorRewardTreasury> {
  try {
    return await syncTreasury(pumpAdapter);
  } catch {
    return getTreasury("REAL");
  }
}

const EMPTY = (source: Source, adapter: CreatorRewardTreasury["adapter"]): CreatorRewardTreasury => ({ balance: 0, received: 0, allocated: 0, distributed: 0, pendingDistribution: 0, currency: "SOL", source, adapter, updatedAt: 0, references: [] });

export async function getTreasury(source: Source = "REAL"): Promise<CreatorRewardTreasury> {
  const t = await getStore().getDoc<CreatorRewardTreasury>("treasury", source);
  return t ?? EMPTY(source, source === "REAL" ? "manual" : "mock");
}

/** Pulls new receipts from the real adapter into the ledger. Idempotent per reference. */
export async function syncTreasury(adapter: CreatorRewardAdapter = manualAdapter): Promise<CreatorRewardTreasury> {
  const store = getStore();
  const t = await getTreasury(adapter.source);
  const receipts = await adapter.poll();
  if (receipts.length === 0) return t;
  for (const r of receipts) {
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
  return [new MockCreatorRewardAdapter(), manualAdapter, pumpAdapter].map((a) => ({ name: a.name, source: a.source, ...a.status() }));
}
