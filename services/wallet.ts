import { createPublicKey, verify } from "node:crypto";
import type { TokenHolding } from "@/domain/types";
import { token as mockToken } from "@/services/mock/mockData";
import { mulberry32 } from "@/network/workloads";
import { hmac, hmacEqual, sha256, token } from "./security";

/* ------------------------------------------------------------------ base58 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function isSolanaAddress(s: string): boolean {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------- sign-in nonce */

const g = globalThis as typeof globalThis & { __brainNonces?: Map<string, { message: string; exp: number }> };
const nonces = (g.__brainNonces ??= new Map());

export function issueNonce(address: string) {
  const nonce = token(12);
  const message = `BRAIN node link\n\nWallet: ${address}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}\n\nSigning proves you own this wallet. It costs nothing and moves no funds.`;
  nonces.set(address, { message, exp: Date.now() + 5 * 60_000 });
  return message;
}

/** Ed25519 verification of a Solana signMessage() signature against a nonce this server issued. */
export function verifySignature(address: string, message: string, signatureB64: string): boolean {
  const entry = nonces.get(address);
  if (!entry || entry.exp < Date.now() || entry.message !== message) return false;
  nonces.delete(address);
  return verifyEd25519(address, message, signatureB64);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

/** Raw Ed25519 check: did `address` sign `message`? Callers must bind freshness themselves. */
export function verifyEd25519(address: string, message: string, signatureB64: string): boolean {
  try {
    const raw = base58Decode(address);
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(raw)]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- link token */

const LINK_TTL_MS = 12 * 60 * 60_000;

/**
 * Proof that this server verified `address` by signature recently. Lets a node that lost its
 * server session (restart, another instance) re-link its wallet without a second signature.
 */
export function issueLinkToken(address: string): string {
  const exp = Date.now() + LINK_TTL_MS;
  return `${address}.${exp}.${hmac(`link|${address}|${exp}`)}`;
}

export function verifyLinkToken(t: string): string | null {
  const [address, expStr, tag] = String(t).split(".");
  const exp = Number(expStr);
  if (!address || !tag || !(exp > Date.now()) || !isSolanaAddress(address)) return null;
  return hmacEqual(hmac(`link|${address}|${exp}`), tag) ? address : null;
}

/* ---------------------------------------------------------------- holdings */

/**
 * Real holdings if SOLANA_RPC_URL + BRAIN_TOKEN_MINT are set; otherwise a deterministic
 * DEMO amount (provenance "simulated") so the flow can be exercised before launch.
 */
export async function getHoldings(address: string): Promise<TokenHolding> {
  const rpc = process.env.SOLANA_RPC_URL;
  const mint = process.env.BRAIN_TOKEN_MINT;
  if (rpc && mint) {
    const call = async (method: string, params: unknown[]) => {
      const r = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        cache: "no-store",
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    };
    // Before the mint exists on-chain, holdings are genuinely zero. Do not fall back to demo numbers.
    const [accounts, supply] = await Promise.all([
      call("getTokenAccountsByOwner", [address, { mint }, { encoding: "jsonParsed" }]).catch(() => ({ value: [] })),
      call("getTokenSupply", [mint]).catch(() => null),
    ]);
    if (!supply) return { address, amount: 0, supplyShare: 0, provenance: "live" };
    const amount = (accounts.value as { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }[])
      .reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
    const total = Number(supply.value.uiAmount) || mockToken.circulatingSupply;
    return { address, amount, supplyShare: amount / total, provenance: "live" };
  }
  const seed = parseInt(sha256(address).slice(0, 8), 16);
  const r = mulberry32(seed)() / 2 ** 32;
  const amount = Math.round(250_000 + Math.pow(r, 2) * 4_750_000);
  return { address, amount, supplyShare: amount / mockToken.circulatingSupply, provenance: "simulated" };
}
