import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { base58Decode, base58Encode, isSolanaAddress } from "./wallet";

/** Sends SOL from the protocol payout wallet. Server-only; the key never leaves this module. */
export interface PayoutSender {
  address: string;
  send(to: string, lamports: number): Promise<string>;
  status(signature: string): Promise<"confirmed" | "failed" | "unknown">;
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SYSTEM_PROGRAM = new Uint8Array(32);

/** Accepts a Solana CLI keypair (JSON array of 64 bytes) or a base58 64-byte secret key. */
export function parseSecretKey(raw: string): Uint8Array {
  const s = raw.trim();
  const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s) as number[]) : base58Decode(s);
  if (bytes.length !== 64) throw new Error("payout key must be 64 bytes");
  return bytes;
}

export function keyFromSecret(secret: Uint8Array): { privateKey: KeyObject; address: string } {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(secret.subarray(0, 32))]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  if (!Buffer.from(secret.subarray(32)).equals(pub)) throw new Error("payout key: public half does not match seed");
  return { privateKey, address: base58Encode(pub) };
}

function compactU16(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n === 0) {
      out.push(b);
      return out;
    }
    b |= 0x80;
    out.push(b);
  }
}

/** Legacy message for a single SystemProgram::Transfer. */
export function transferMessage(from: string, to: string, lamports: number, recentBlockhash: string): Buffer {
  if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error("invalid lamports");
  if (from === to) throw new Error("payout to self");
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4);
  return Buffer.concat([
    Buffer.from([1, 0, 1]), // 1 signer, 0 readonly signed, 1 readonly unsigned (system program)
    Buffer.from(compactU16(3)),
    Buffer.from(base58Decode(from)),
    Buffer.from(base58Decode(to)),
    Buffer.from(SYSTEM_PROGRAM),
    Buffer.from(base58Decode(recentBlockhash)),
    Buffer.from(compactU16(1)),
    Buffer.from([2, ...compactU16(2), 0, 1, ...compactU16(data.length)]),
    data,
  ]);
}

export function signedTransfer(privateKey: KeyObject, from: string, to: string, lamports: number, recentBlockhash: string) {
  const message = transferMessage(from, to, lamports, recentBlockhash);
  const signature = sign(null, message, privateKey);
  return { signature: base58Encode(signature), wire: Buffer.concat([Buffer.from(compactU16(1)), signature, message]) };
}

export function solanaPayoutSender(rpcUrl: string, secret: Uint8Array): PayoutSender {
  const { privateKey, address } = keyFromSecret(secret);
  const rpc = async <T,>(method: string, params: unknown[]): Promise<T> => {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
    });
    const j = await r.json();
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
    return j.result as T;
  };
  return {
    address,
    async send(to, lamports) {
      if (!isSolanaAddress(to)) throw new Error("invalid recipient");
      const { value } = await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const tx = signedTransfer(privateKey, address, to, lamports, value.blockhash);
      // Preflight simulation rejects underfunded transfers before anything is broadcast.
      await rpc<string>("sendTransaction", [tx.wire.toString("base64"), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
      return tx.signature;
    },
    async status(signature) {
      const { value } = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [
        [signature],
        { searchTransactionHistory: true },
      ]);
      const s = value[0];
      if (!s) return "unknown";
      if (s.err) return "failed";
      return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "confirmed" : "unknown";
    },
  };
}
