import { protocolWallet, token } from "@/lib/site";
import { payoutStatus } from "./claims";
import { payoutAddress } from "./payouts";
import { creatorVaults, LAMPORTS, readTransfer, rpc, rpcUrl, TOKEN_ACCOUNT_RENT, type WalletTransfer } from "./solana";

export { creatorVaults, PUMP_PROGRAMS, readTransfer, type WalletTransfer } from "./solana";


/**
 * Read-only view of the protocol wallet, straight from a Solana RPC. Everything here is REAL
 * (on-chain) or UNKNOWN (RPC unreachable). It is deliberately separate from the creator-reward
 * ledger: an inbound transfer is just an inbound transfer until an operator confirms its
 * signature as a creator-fee claim via POST /api/treasury. Nothing is inferred.
 */

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
  payout: { address: string; balanceSol: number | null; enabled: boolean; opensAt?: number } | null;
  /** Unclaimed creator fees sitting in pump.fun's vault PDAs for our wallet. On-chain; null = unreadable. */
  creatorVault: { bonding: { address: string; sol: number | null }; amm: { address: string; sol: number | null }; totalSol: number | null };
}

const TTL_MS = 60_000;


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
  // The wallet is shown whenever a key is configured, even while payouts are switched off: its balance is what funds epochs.
  const payoutAddr = ps.wallet ?? payoutAddress();
  const payout = payoutAddr ? { address: payoutAddr, balanceSol: null as number | null, enabled: ps.enabled, ...(ps.opensAt ? { opensAt: ps.opensAt } : {}) } : null;
  const vaults = creatorVaults(address);
  const creatorVault: ProtocolWalletView["creatorVault"] = { bonding: { address: vaults.bonding, sol: null }, amm: { address: vaults.ammWsol, sol: null }, totalSol: null };
  const base: ProtocolWalletView = { address, cluster: protocolWallet.cluster, source: "REAL", balanceSol: null, recent: [], fetchedAt: Date.now(), rpc: "unavailable", token: tokenStatus, payout, creatorVault };
  try {
    // One call for every balance we show: protocol wallet, payout wallet, both creator vaults.
    const keys = [address, vaults.bonding, vaults.ammWsol, ...(payout ? [payout.address] : [])];
    const multi = await rpc<{ value: ({ lamports: number } | null)[] }>(url, "getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }]);
    const lam = (i: number) => (multi.value[i] ? multi.value[i]!.lamports : 0) / LAMPORTS;
    const bal = { value: (multi.value[0]?.lamports ?? 0) };
    creatorVault.bonding.sol = lam(1);
    // PumpSwap fees are wrapped SOL: the account's lamports minus its rent is the claimable amount.
    creatorVault.amm.sol = multi.value[2] ? Math.max(0, multi.value[2]!.lamports - TOKEN_ACCOUNT_RENT) / LAMPORTS : 0;
    creatorVault.totalSol = creatorVault.bonding.sol + creatorVault.amm.sol;
    if (payout) payout.balanceSol = lam(3);
    const sigs = await rpc<{ signature: string; blockTime: number | null; err: unknown }[]>(url, "getSignaturesForAddress", [address, { limit }]);
    const recent: WalletTransfer[] = [];
    for (const s of sigs) {
      if (s.err) continue;
      try {
        const t = await readTransfer(url, address, s.signature, s.blockTime);
        if (t) recent.push(t);
      } catch {
        /* skip a single unreadable tx; the balance above is still authoritative */
      }
    }
    const view: ProtocolWalletView = { ...base, balanceSol: bal.value / LAMPORTS, recent, rpc: kind, payout, creatorVault };
    g.__brainProtocolWallet = { at: Date.now(), view };
    return view;
  } catch {
    // Keep a stale-but-real view for up to 10 minutes rather than flashing UNKNOWN on a blip.
    if (cached && Date.now() - cached.at < 10 * TTL_MS) return cached.view;
    return base;
  }
}
