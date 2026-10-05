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

/** Creator-fee vault PDAs for our protocol wallet. Pure derivation; verified against chain (the bonding vault held fees at launch). */
export function creatorVaults(creator: string = protocolWallet.address) {
  const c = new PublicKey(creator);
  const [bonding] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), c.toBuffer()], new PublicKey(PUMP_PROGRAMS.bondingCurve));
  const [amm] = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), c.toBuffer()], new PublicKey(PUMP_PROGRAMS.amm));
  return { bonding: bonding.toBase58(), amm: amm.toBase58() };
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
export async function readTransfer(url: string, address: string, signature: string, blockTime: number | null): Promise<WalletTransfer | null> {
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
  // A claim drains a vault PDA and credits the wallet in the same transaction. Count only what the vault lost,
  // capped by what the wallet gained, so swaps or unrelated inbound transfers never register as creator fees.
  const vaults = creatorVaults(address);
  let vaultOut = 0;
  for (const v of [vaults.bonding, vaults.amm]) {
    const j = keys.indexOf(v);
    if (j >= 0) vaultOut += Math.max(0, tx.meta.preBalances[j] - tx.meta.postBalances[j]);
  }
  const creatorFeeSol = pump && deltaSol > 0 && vaultOut > 0 ? Math.min(vaultOut / LAMPORTS, deltaSol) : 0;
  return { signature, at: blockTime ? blockTime * 1000 : null, deltaSol, pump, creatorFeeSol };
}

