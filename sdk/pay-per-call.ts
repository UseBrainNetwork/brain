/**
 * brain pay-per-call client. One file, one dependency (@solana/web3.js). Copy it into your agent.
 *
 *   import { Keypair } from "@solana/web3.js";
 *   import { brainPaidChat } from "./pay-per-call";
 *
 *   const wallet = Keypair.fromSecretKey(...);
 *   const r = await brainPaidChat({ wallet, currency: "SOL", body: {
 *     model: "brain/auto", messages: [{ role: "user", content: "Hello" }], max_tokens: 200,
 *   }});
 *   console.log(r.completion.choices[0].message.content, r.receiptId, r.paid);
 *
 * Flow (x402 shape on Solana): ask → 402 with an exact quote for this request → pay from the
 * wallet with the quote's memo → re-send the same body with x-brain-payment: <id>:<signature>.
 * The server verifies the transfer on chain before serving; the response carries a signed receipt id.
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";

export interface PaymentRequired {
  id: string;
  currency: "SOL" | "USDC";
  amount: number;
  amountUsd: number;
  baseUnits: number;
  to: string;
  memo: string;
  cluster: "mainnet-beta" | "devnet" | "testnet";
  expiresAt: number;
  budgetTokens: number;
  solUsd?: number;
}

export interface PaidChatOptions {
  wallet: Keypair;
  body: Record<string, unknown>;
  currency?: "SOL" | "USDC";
  baseUrl?: string;
  rpcUrl?: string;
  /** Refuse to pay above this many USD for one call. Default 0.05. */
  maxUsd?: number;
  fetchImpl?: typeof fetch;
}

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const USDC_MAINNET = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const ata = (owner: PublicKey, mint: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

/** Step 1: get the quote. Throws if the server answers anything but 402. */
export async function quote(o: PaidChatOptions): Promise<PaymentRequired> {
  const f = o.fetchImpl ?? fetch;
  const r = await f(`${(o.baseUrl ?? "https://brainnetwork.app").replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-brain-pay": o.currency ?? "SOL" },
    body: JSON.stringify(o.body),
  });
  const j = (await r.json()) as { payment?: PaymentRequired; error?: { code: string; message: string } };
  if (r.status !== 402 || !j.payment) throw new Error(`expected a 402 quote, got ${r.status}: ${j.error?.message ?? "unknown"}`);
  return j.payment;
}

/** Step 2: pay the quote from the wallet. Returns the transaction signature. */
export async function pay(p: PaymentRequired, wallet: Keypair, rpcUrl?: string): Promise<string> {
  const conn = new Connection(rpcUrl ?? (p.cluster === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : `https://api.${p.cluster}.solana.com`), "confirmed");
  const to = new PublicKey(p.to);
  const tx = new Transaction();
  if (p.currency === "SOL") {
    tx.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: to, lamports: p.baseUnits }));
  } else {
    const mint = p.cluster === "mainnet-beta" ? USDC_MAINNET : USDC_DEVNET;
    const data = Buffer.alloc(10);
    data.writeUInt8(12, 0); // TransferChecked
    data.writeBigUInt64LE(BigInt(p.baseUnits), 1);
    data.writeUInt8(6, 9);
    tx.add(
      new TransactionInstruction({
        programId: ATA_PROGRAM,
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: ata(to, mint), isSigner: false, isWritable: true },
          { pubkey: to, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
      new TransactionInstruction({
        programId: TOKEN_PROGRAM,
        keys: [
          { pubkey: ata(wallet.publicKey, mint), isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: ata(to, mint), isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
        ],
        data,
      }),
    );
  }
  tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(p.memo, "utf8") }));
  return sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed" });
}

/** Step 3: the paid request. */
export async function redeem(o: PaidChatOptions, p: PaymentRequired, signature: string) {
  const f = o.fetchImpl ?? fetch;
  const r = await f(`${(o.baseUrl ?? "https://brainnetwork.app").replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-brain-payment": `${p.id}:${signature}` },
    body: JSON.stringify(o.body),
  });
  const completion = (await r.json()) as Record<string, unknown> & { error?: { code: string; message: string } };
  if (!r.ok) throw new Error(`request failed ${r.status}: ${completion.error?.message ?? "unknown"}`);
  return { completion, receiptId: r.headers.get("x-brain-receipt"), receiptVerifyUrl: r.headers.get("x-brain-receipt-url"), paid: p, signature };
}

/** All three steps. Refuses to pay above `maxUsd`. */
export async function brainPaidChat(o: PaidChatOptions) {
  const p = await quote(o);
  if (p.amountUsd > (o.maxUsd ?? 0.05)) throw new Error(`quote is $${p.amountUsd} for this call; limit is $${o.maxUsd ?? 0.05}`);
  const signature = await pay(p, o.wallet, o.rpcUrl);
  return redeem(o, p, signature);
}
