import { protocolWallet, token } from "@/lib/site";
import { payoutStatus } from "./claims";

/**
 * Read-only view of the protocol wallet, straight from a Solana RPC. Everything here is REAL
 * (on-chain) or UNKNOWN (RPC unreachable). It is deliberately separate from the creator-reward
 * ledger: an inbound transfer is just an inbound transfer until an operator confirms its
 * signature as a creator-fee claim via POST /api/treasury. Nothing is inferred.
 */
export interface WalletTransfer {
  signature: string;
  at: number | null;
  /** Net SOL change for the protocol wallet in this transaction (positive = inbound). */
  deltaSol: number;
}

export interface TokenStatus {
  symbol: string;
  mint: string;
  /** true once the mint account exists on-chain. null = RPC unavailable. */
  live: boolean | null;
  supply: number | null;
  decimals: number | null;
  fetchedAt: number;
}

export interface ProtocolWalletView {
  address: string;
  cluster: string;
  source: "REAL";
  /** null = RPC unavailable → render UNKNOWN. */
  balanceSol: number | null;
  recent: WalletTransfer[];
  fetchedAt: number;
  rpc: "configured" | "public" | "unavailable";
  token: TokenStatus;
  /** Hot wallet claims are paid from. null when payouts are not configured. */
  payout: { address: string; balanceSol: number | null; enabled: boolean } | null;
}

const LAMPORTS = 1e9;
const TTL_MS = 60_000;
const PUBLIC_RPC: Record<string, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
};

function rpcUrl(): { url: string; kind: "configured" | "public" } {
  const u = process.env.SOLANA_RPC_URL;
  if (u) return { url: u, kind: "configured" };
  return { url: PUBLIC_RPC[protocolWallet.cluster] ?? PUBLIC_RPC["mainnet-beta"], kind: "public" };
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(6000),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`rpc ${method} ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result as T;
}

const g = globalThis as typeof globalThis & { __brainProtocolWallet?: { at: number; view: ProtocolWalletView }; __brainTokenStatus?: { at: number; status: TokenStatus } };

/** Does the mint exist yet? Read from chain; never assumed. */
export async function getTokenStatus(): Promise<TokenStatus> {
  const cached = g.__brainTokenStatus;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.status;
  const { url } = rpcUrl();
  const base: TokenStatus = { symbol: token.symbol, mint: token.mint, live: null, supply: null, decimals: null, fetchedAt: Date.now() };
  try {
    const info = await rpc<{ value: { owner: string } | null }>(url, "getAccountInfo", [token.mint, { encoding: "base64", commitment: "confirmed" }]);
    let status: TokenStatus = { ...base, live: Boolean(info.value) };
    if (info.value) {
      try {
        const s = await rpc<{ value: { uiAmount: number | null; decimals: number } }>(url, "getTokenSupply", [token.mint]);
        status = { ...status, supply: s.value.uiAmount, decimals: s.value.decimals };
      } catch {
        /* exists but not a mint we can read; still "live" as an account */
      }
    }
    g.__brainTokenStatus = { at: Date.now(), status };
    return status;
  } catch {
    if (cached && Date.now() - cached.at < 10 * TTL_MS) return cached.status;
    return base;
  }
}

export async function getProtocolWallet(limit = 8): Promise<ProtocolWalletView> {
  const cached = g.__brainProtocolWallet;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.view;
  const { url, kind } = rpcUrl();
  const address = protocolWallet.address;
  const tokenStatus = await getTokenStatus();
  const ps = payoutStatus();
  const payout = ps.wallet ? { address: ps.wallet, balanceSol: null as number | null, enabled: ps.enabled } : null;
  const base: ProtocolWalletView = { address, cluster: protocolWallet.cluster, source: "REAL", balanceSol: null, recent: [], fetchedAt: Date.now(), rpc: "unavailable", token: tokenStatus, payout };
  try {
    const bal = await rpc<{ value: number }>(url, "getBalance", [address, { commitment: "confirmed" }]);
    const sigs = await rpc<{ signature: string; blockTime: number | null; err: unknown }[]>(url, "getSignaturesForAddress", [address, { limit }]);
    const recent: WalletTransfer[] = [];
    for (const s of sigs) {
      if (s.err) continue;
      try {
        const tx = await rpc<{ transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } }; meta: { preBalances: number[]; postBalances: number[] } } | null>(url, "getTransaction", [
          s.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
        ]);
        if (!tx) continue;
        const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
        const i = keys.indexOf(address);
        if (i < 0) continue;
        recent.push({ signature: s.signature, at: s.blockTime ? s.blockTime * 1000 : null, deltaSol: (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / LAMPORTS });
      } catch {
        /* skip a single unreadable tx; the balance above is still authoritative */
      }
    }
    if (payout) {
      try {
        const pb = await rpc<{ value: number }>(url, "getBalance", [payout.address, { commitment: "confirmed" }]);
        payout.balanceSol = pb.value / LAMPORTS;
      } catch {
        /* leave null → UNKNOWN */
      }
    }
    const view: ProtocolWalletView = { ...base, balanceSol: bal.value / LAMPORTS, recent, rpc: kind, payout };
    g.__brainProtocolWallet = { at: Date.now(), view };
    return view;
  } catch {
    // Keep a stale-but-real view for up to 10 minutes rather than flashing UNKNOWN on a blip.
    if (cached && Date.now() - cached.at < 10 * TTL_MS) return cached.view;
    return base;
  }
}
