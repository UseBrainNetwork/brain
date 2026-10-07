import { PublicKey } from "@solana/web3.js";
import { protocolWallet } from "@/lib/site";

/**
 * Minimal Solana JSON-RPC reader shared by the protocol-wallet view and the creator-fee adapter.
 * No dependencies on the rest of services/ so it can be imported from anywhere without cycles.
 */

export const LAMPORTS = 1_000_000_000;

/** pump.fun programs. Creator fees accrue in per-creator vault PDAs and are claimed to the creator wallet. */
export const PUMP_PROGRAMS = {
  bondingCurve: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  amm: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  fee: "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
} as const;
export const PUMP_PROGRAM_IDS = new Set<string>(Object.values(PUMP_PROGRAMS));

const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** Rent-exempt minimum for a 165-byte SPL token account; a WSOL account's lamports = amount + this. */
export const TOKEN_ACCOUNT_RENT = 2_039_280;

export function wsolAta(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), WSOL.toBuffer()], ATA_PROGRAM)[0];
}

/**
 * Creator-fee vaults for our protocol wallet. Pure derivation, verified against chain.
 *   bonding  pump.fun bonding-curve vault (plain SOL), fees before graduation
 *   amm      PumpSwap creator_vault authority; its fees sit as wrapped SOL in `ammWsol`, the authority's WSOL ATA
 */
export function creatorVaults(creator: string = protocolWallet.address) {
  const c = new PublicKey(creator);
  const [bonding] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), c.toBuffer()], new PublicKey(PUMP_PROGRAMS.bondingCurve));
  const [amm] = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), c.toBuffer()], new PublicKey(PUMP_PROGRAMS.amm));
  return { bonding: bonding.toBase58(), amm: amm.toBase58(), ammWsol: wsolAta(amm).toBase58(), creatorWsol: wsolAta(c).toBase58() };
}

export interface WalletTransfer {
  signature: string;
  at: number | null;
  /** Net SOL change for the protocol wallet in this transaction (positive = inbound). */
  deltaSol: number;
  /** True when the transaction invoked a pump.fun program. */
  pump: boolean;
  /** SOL that moved out of our pump.fun creator-fee vaults in this transaction (a creator-fee claim). 0 otherwise. */
  creatorFeeSol: number;
  /** Net SOL change for each `watch` address passed to readTransfer (0 when not in the transaction). */
  watched: Record<string, number>;
}

const PUBLIC_RPC: Record<string, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
};

export function rpcUrl(): { url: string; kind: "configured" | "public" } {
  const u = process.env.SOLANA_RPC_URL;
  if (u) return { url: u, kind: "configured" };
  return { url: PUBLIC_RPC[protocolWallet.cluster] ?? PUBLIC_RPC["mainnet-beta"], kind: "public" };
}

export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
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

type ParsedTx = {
  transaction: { message: { accountKeys: ({ pubkey: string } | string)[]; instructions: { programId?: string }[] } };
  meta: { preBalances: number[]; postBalances: number[]; innerInstructions?: { instructions: { programId?: string }[] }[] };
} | null;

/** Net SOL delta for `address` in one confirmed transaction, plus whether a pump.fun program was involved. */
export async function readTransfer(url: string, address: string, signature: string, blockTime: number | null, watch: string[] = []): Promise<WalletTransfer | null> {
  const tx = await rpc<ParsedTx>(url, "getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  if (!tx) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const i = keys.indexOf(address);
  if (i < 0) return null;
  const programs = new Set<string>();
  for (const ins of tx.transaction.message.instructions) if (ins.programId) programs.add(ins.programId);
  for (const inner of tx.meta.innerInstructions ?? []) for (const ins of inner.instructions) if (ins.programId) programs.add(ins.programId);
  const pump = [...programs].some((p) => PUMP_PROGRAM_IDS.has(p)) || keys.some((k) => PUMP_PROGRAM_IDS.has(k));
  const deltaSol = (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / LAMPORTS;
  // A claim drains a vault and credits the creator in the same transaction. Count only what the vaults lost,
  // capped by what the creator gained (as SOL, or as wrapped SOL in its own WSOL account when the claim is not
  // unwrapped), so swaps or unrelated inbound transfers never register as creator fees.
  const vaults = creatorVaults(address);
  const lamDelta = (k: string) => {
    const j = keys.indexOf(k);
    return j >= 0 ? tx.meta.postBalances[j] - tx.meta.preBalances[j] : 0;
  };
  const vaultOut = [vaults.bonding, vaults.amm, vaults.ammWsol].reduce((s, v) => s + Math.max(0, -lamDelta(v)), 0);
  const gained = Math.max(0, lamDelta(address)) + Math.max(0, lamDelta(vaults.creatorWsol));
  const creatorFeeSol = pump && vaultOut > 0 && gained > 0 ? Math.min(vaultOut, gained) / LAMPORTS : 0;
  const watched: Record<string, number> = {};
  for (const w of watch) watched[w] = lamDelta(w) / LAMPORTS;
  return { signature, at: blockTime ? blockTime * 1000 : null, deltaSol, pump, creatorFeeSol, watched };
}

