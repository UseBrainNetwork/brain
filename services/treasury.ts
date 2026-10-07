import type { CreatorRewardTreasury, Source } from "@/domain/economy";
import { protocolWallet, token } from "@/lib/site";
import { record } from "./accounting";
import { payoutAddress } from "./payouts";
import { getProtocolWallet } from "./protocolWallet";
import { configuredPoolLamports, LAMPORTS_PER_SOL } from "./settlement";
import { readTransfer, rpc as solanaCall, rpcUrl as solanaRpc } from "./solana";
import { getStore } from "./store";

/**
 * Creator-reward treasury: where contributor money comes from and where it stands.
 *
 * The app keeps no hand-maintained balance. Three independent sources are combined on every read:
 *   chain history   every protocol-wallet transaction, classified by signature (creator-fee claim,
 *                   deposit, transfer to the payout wallet, other withdrawal) — the stored ledger
 *                   is only a cache of that classification and can be rebuilt with `rescanTreasury`
 *   chain balances  protocol wallet and payout wallet SOL, read live (UNKNOWN when RPC is down)
 *   database        allocated = Σ live epochs, distributed = Σ claims; the difference is what is owed
 *
 * Adapters:
 *   MockCreatorRewardAdapter    SIMULATED numbers for the demo site. Never enters REAL totals.
 *   ManualCreatorRewardAdapter  operator records a real receipt by hand with a tx signature.
 *   PumpFunCreatorRewardAdapter reads the chain. Nothing is estimated; unclaimed fees still in the
 *                               vault are shown separately and never enter the ledger until claimed.
 */

export type TreasuryEventKind = "creator_fee" | "deposit" | "payout_funding" | "withdrawal";

export interface TreasuryEvent {
  kind: TreasuryEventKind;
  amountSol: number;
  reference: string;
  at: number;
}

export interface CreatorRewardAdapter {
  readonly name: CreatorRewardTreasury["adapter"];
  readonly source: Source;
  /** Returns newly observed protocol-wallet events since the last call, by signature. */
  poll(): Promise<TreasuryEvent[]>;
  status(): { ok: boolean; detail: string };
}

/** The persisted part: chain-history classification by signature. Everything else is derived on read. */
interface StoredTreasury {
  received: number;
  deposited: number;
  payoutFunded: number;
  withdrawn: number;
  source: Source;
  adapter: CreatorRewardTreasury["adapter"];
  updatedAt: number;
  references: string[];
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
  private queue: TreasuryEvent[] = [];
  /** Operator-authenticated route pushes here; see app/api/treasury/route.ts. */
  add(amountSol: number, reference: string, at = Date.now()) {
    if (!(amountSol > 0) || !/^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(reference)) throw new Error("manual adapter: amount must be > 0 and reference a Solana signature");
    this.queue.push({ kind: "creator_fee", amountSol, reference, at });
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
const POLL_PAGE = 100;
/** Bounds one scan. A full rebuild of a busy wallet continues on the next poll from where it stopped. */
const MAX_PAGES_PER_POLL = 10;

export class PumpFunCreatorRewardAdapter implements CreatorRewardAdapter {
  readonly name = "pumpfun" as const;
  readonly source = "REAL" as const;
  private lastPollAt = 0;
  private lastError: string | null = null;

  enabled() {
    return Boolean(token.mint) && Boolean(protocolWallet.address);
  }

  /** Forget the throttle so the next poll scans immediately (used after a cursor reset). */
  resetThrottle() {
    this.lastPollAt = 0;
  }

  /**
   * Walks signatures for the protocol wallet newest→oldest until the saved cursor (or the beginning of
   * the wallet's history when there is none), then reads each transaction oldest→newest and classifies
   * it. The cursor only advances past transactions that were read, so an RPC hiccup delays an event
   * rather than dropping it. Throttled to one chain scan per minute.
   */
  async poll() {
    if (!this.enabled()) return [];
    const now = Date.now();
    if (now - this.lastPollAt < POLL_MIN_INTERVAL_MS) return [];
    this.lastPollAt = now;
    const store = getStore();
    const cursor = await store.getDoc<PumpCursor>("treasury", "pumpfun:cursor");
    const { url } = solanaRpc();
    const payout = payoutAddress();
    const out: TreasuryEvent[] = [];
    try {
      type Sig = { signature: string; blockTime: number | null; err: unknown };
      const sigs: Sig[] = [];
      let before: string | undefined;
      for (let page = 0; page < MAX_PAGES_PER_POLL; page++) {
        const batch = await solanaCall<Sig[]>(url, "getSignaturesForAddress", [
          protocolWallet.address,
          { limit: POLL_PAGE, commitment: "confirmed", ...(cursor ? { until: cursor.signature } : {}), ...(before ? { before } : {}) },
        ]);
        sigs.push(...batch);
        if (batch.length < POLL_PAGE) break;
        before = batch[batch.length - 1].signature;
      }
      let newest: PumpCursor | null = null;
      for (const s of [...sigs].reverse()) {
        if (!s.err) {
          const t = await readTransfer(url, protocolWallet.address, s.signature, s.blockTime, payout ? [payout] : []);
          const ev = t ? classify(t, payout) : null;
          if (ev) out.push(ev);
        }
        newest = { signature: s.signature, at: now };
      }
      if (newest) await store.putDoc("treasury", "pumpfun:cursor", newest, { at: now, key: "pumpfun:cursor" });
      this.lastError = null;
    } catch (e) {
      // Partial progress is kept by the caller (events are idempotent per signature); the cursor is not advanced.
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
        : `classifies every protocol-wallet transaction (${protocolWallet.address.slice(0, 4)}…${protocolWallet.address.slice(-4)}) by signature: creator-fee claims, deposits, payout-wallet funding, withdrawals`,
    };
  }
}

/** One transaction → at most one event. Creator-fee claims win; otherwise the wallet's net SOL direction decides. */
function classify(t: Awaited<ReturnType<typeof readTransfer>> & object, payout: string | null): TreasuryEvent | null {
  const at = t.at ?? Date.now();
  if (t.creatorFeeSol > 0) return { kind: "creator_fee", amountSol: t.creatorFeeSol, reference: t.signature, at };
  if (t.deltaSol < 0) {
    const toPayout = payout ? t.watched[payout] ?? 0 : 0;
    return { kind: toPayout > 0 ? "payout_funding" : "withdrawal", amountSol: -t.deltaSol, reference: t.signature, at };
  }
  if (t.deltaSol > 0) return { kind: "deposit", amountSol: t.deltaSol, reference: t.signature, at };
  return null;
}

const g = globalThis as typeof globalThis & { __brainManualAdapter?: ManualCreatorRewardAdapter; __brainPumpAdapter?: PumpFunCreatorRewardAdapter };
export const manualAdapter = (g.__brainManualAdapter ??= new ManualCreatorRewardAdapter());
export const pumpAdapter = (g.__brainPumpAdapter ??= new PumpFunCreatorRewardAdapter());

/** Pulls any new on-chain events into the REAL ledger, then returns the full view with live balances. */
export async function syncedTreasury(): Promise<CreatorRewardTreasury> {
  let t: CreatorRewardTreasury;
  try {
    t = await syncTreasury(pumpAdapter);
  } catch {
    t = await getTreasury("REAL");
  }
  return withChainBalances(t);
}

const EMPTY = (source: Source, adapter: CreatorRewardTreasury["adapter"]): StoredTreasury => ({ received: 0, deposited: 0, payoutFunded: 0, withdrawn: 0, source, adapter, updatedAt: 0, references: [] });

async function getStored(source: Source): Promise<StoredTreasury> {
  const t = await getStore().getDoc<Partial<StoredTreasury>>("treasury", source);
  const base = EMPTY(source, source === "REAL" ? "manual" : "mock");
  // Older documents carried hand-kept balance/allocated fields; only the chain-side figures are read.
  return t ? { ...base, received: t.received ?? 0, deposited: t.deposited ?? 0, payoutFunded: t.payoutFunded ?? 0, withdrawn: t.withdrawn ?? 0, adapter: t.adapter ?? base.adapter, updatedAt: t.updatedAt ?? 0, references: t.references ?? [] } : base;
}

/** Σ live epochs and Σ claims from the database. The only place "allocated" and "distributed" are defined. */
export async function rewardLiabilities(): Promise<{ allocated: number; distributed: number }> {
  const store = getStore();
  const epochs = await store.listEpochs(5000);
  const allocatedLamports = epochs.filter((e) => e.provenance === "live").reduce((s, e) => s + e.distributedLamports, 0);
  const distributedLamports = await store.claimedSince(0);
  return { allocated: allocatedLamports / LAMPORTS_PER_SOL, distributed: distributedLamports / LAMPORTS_PER_SOL };
}

/** Ledger + database liabilities. Balances are left UNKNOWN; `syncedTreasury` fills them from chain. */
export async function getTreasury(source: Source = "REAL"): Promise<CreatorRewardTreasury> {
  const s = await getStored(source);
  const { allocated, distributed } = source === "REAL" ? await rewardLiabilities() : { allocated: 0, distributed: 0 };
  const pool = configuredPoolLamports();
  return {
    ...s,
    balance: null,
    allocated,
    distributed,
    pendingDistribution: Math.max(0, allocated - distributed),
    payoutWallet: null,
    poolPerEpoch: pool == null ? null : pool / LAMPORTS_PER_SOL,
    runwayEpochs: null,
    currency: "SOL",
  };
}

/** Adds live on-chain balances and the payout runway. Never throws; unreadable balances stay null. */
export async function withChainBalances(t: CreatorRewardTreasury): Promise<CreatorRewardTreasury> {
  if (t.source !== "REAL") return t;
  try {
    const w = await getProtocolWallet();
    const payoutWallet = w.payout ? { address: w.payout.address, balance: w.payout.balanceSol } : null;
    const runwayEpochs = payoutWallet?.balance != null && t.poolPerEpoch ? (payoutWallet.balance - t.pendingDistribution) / t.poolPerEpoch : null;
    return { ...t, balance: w.balanceSol, payoutWallet, runwayEpochs };
  } catch {
    return t;
  }
}

/** Pulls new events from an adapter into the ledger. Idempotent per signature. */
export async function syncTreasury(adapter: CreatorRewardAdapter = manualAdapter): Promise<CreatorRewardTreasury> {
  const events = await adapter.poll();
  if (events.length === 0) return getTreasury(adapter.source);
  await applyEvents(adapter, events, new Set());
  return getTreasury(adapter.source);
}

async function applyEvents(adapter: CreatorRewardAdapter, events: TreasuryEvent[], alreadyBooked: Set<string>) {
  const store = getStore();
  const t = await getStored(adapter.source);
  const seen = new Set(t.references);
  for (const r of events) {
    if (seen.has(r.reference)) continue;
    seen.add(r.reference);
    t.references.push(r.reference);
    if (r.kind === "creator_fee") {
      t.received += r.amountSol;
      // Accounting events are append-only; a rebuild must not book the same claim twice.
      if (!alreadyBooked.has(r.reference)) {
        await record({ type: "CREATOR_REWARD_RECEIVED", amount: r.amountSol, currency: "SOL", timestamp: r.at, source: adapter.source, settlement: "settled", transactionReference: r.reference, note: `${adapter.name} adapter` });
      }
    } else if (r.kind === "deposit") t.deposited += r.amountSol;
    else if (r.kind === "payout_funding") t.payoutFunded += r.amountSol;
    else t.withdrawn += r.amountSol;
  }
  t.adapter = adapter.name;
  t.updatedAt = Date.now();
  await store.putDoc("treasury", adapter.source, t, { at: t.updatedAt, key: adapter.source });
}

/**
 * Operator action: rebuild the REAL ledger from the protocol wallet's full on-chain history. Drops the
 * scan cursor and the chain-side figures, then scans from the beginning. Previously booked creator-fee
 * receipts are kept out of accounting so totals there do not double. Liabilities are unaffected (they
 * are read from epochs and claims, not stored here).
 */
export async function rescanTreasury(): Promise<CreatorRewardTreasury> {
  const store = getStore();
  const prev = await getStored("REAL");
  const fresh: StoredTreasury = { ...EMPTY("REAL", "pumpfun"), updatedAt: Date.now() };
  await store.putDoc("treasury", "REAL", fresh, { at: fresh.updatedAt, key: "REAL" });
  await store.putDoc("treasury", "pumpfun:cursor", null, { at: Date.now(), key: "pumpfun:cursor" });
  pumpAdapter.resetThrottle();
  const events = await pumpAdapter.poll();
  await applyEvents(pumpAdapter, events, new Set(prev.references));
  return withChainBalances(await getTreasury("REAL"));
}

export function adapterStatuses() {
  return [new MockCreatorRewardAdapter(), manualAdapter, pumpAdapter].map((a) => ({ name: a.name, source: a.source, ...a.status() }));
}
