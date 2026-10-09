import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./store";
import type { ParsedPaymentTx } from "./payments";

vi.mock("server-only", () => ({}));
vi.mock("./solPrice", async (orig) => {
  const m = (await orig()) as typeof import("./solPrice");
  return { ...m, solUsd: vi.fn(async () => ({ usd: 100, source: "coinbase+jupiter" as const, at: 0 })) };
});
const chain = vi.hoisted(() => ({ tx: null as ParsedPaymentTx | null }));
vi.mock("./solana", async (orig) => {
  const m = (await orig()) as typeof import("./solana");
  return { ...m, rpcUrl: () => ({ url: "mock://", source: "test" }), rpc: vi.fn(async () => chain.tx) };
});

const { PaymentError } = await import("./payments");
const { MIN_CALL_USD, attachCallResult, budgetTokens, getCallQuote, quoteCall, redeemCall, requestHashOf, parsePaymentHeader } = await import("./payPerCall");
const { confirmedSales, salesPool } = await import("./poolSources");

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };
const TO = "HZLev74M3ATV5jQJsoN8FcJAKx3RUefAobhcXr3egxwa";
const PAYER = "M65EFcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAt0";
const SIG = "5".repeat(88);

const solTx = (lamportsIn: number, memo: string, blockTime = 1_000): ParsedPaymentTx => ({
  blockTime,
  meta: { err: null, preBalances: [1_000_000_000, 5_000], postBalances: [1_000_000_000 - lamportsIn - 5000, 5_000 + lamportsIn] },
  transaction: {
    message: {
      accountKeys: [
        { pubkey: PAYER, signer: true },
        { pubkey: TO, signer: false },
      ],
      instructions: [{ program: "system", programId: "11111111111111111111111111111111" }, { program: "spl-memo", programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: memo }],
    },
  },
});

const body = { model: "brain/auto", messages: [{ role: "user", content: "hello there" }], max_tokens: 100 };
const chat = { model: "brain/auto", messages: [{ role: "user" as const, content: "hello there" }], max_tokens: 100 };

describe("pay per call", () => {
  beforeEach(() => {
    g.__brainStore = new MemoryStore();
    process.env.BRAIN_PRICE_USD_PER_1M_TOKENS = "1";
    delete process.env.BRAIN_PAYMENTS;
    chain.tx = null;
  });

  it("hashes the request without pay fields; budget is prompt estimate plus max_tokens", () => {
    expect(requestHashOf({ ...body, pay: "sol" })).toBe(requestHashOf(body));
    expect(requestHashOf({ ...body, max_tokens: 101 })).not.toBe(requestHashOf(body));
    expect(budgetTokens(chat)).toBe(Math.ceil(11 / 4) + 100);
    expect(parsePaymentHeader("call_abc:sig")).toEqual({ quoteId: "call_abc", signature: "sig" });
    expect(parsePaymentHeader("nonsense")).toBeNull();
  });

  it("quotes at list price with the published floor, in SOL or USDC", async () => {
    const sol = await quoteCall(body, chat, "SOL", 1_000_000);
    // 103 tokens at $1/1M = $0.000103 → floored to MIN_CALL_USD, then at $100/SOL rounded up to a micro-SOL.
    expect(sol.amountUsd).toBe(MIN_CALL_USD);
    expect(sol.baseUnits).toBe(Math.ceil((MIN_CALL_USD / 100) * 1e9 / 1000) * 1000);
    expect(sol.memo).toBe(`brain:${sol.id}`);
    expect(sol.to).toBe(TO);
    expect(sol.status).toBe("pending");
    const usdc = await quoteCall(body, chat, "USDC", 1_000_000);
    expect(usdc.baseUnits).toBe(Math.ceil(MIN_CALL_USD * 1e6));
    const big = await quoteCall({ ...body, max_tokens: 50_000 }, { ...chat, max_tokens: 50_000 }, "USDC", 1_000_000);
    expect(big.amountUsd).toBeCloseTo(0.050003, 6);
  });

  it("refuses to quote without a list price or with payments off", async () => {
    delete process.env.BRAIN_PRICE_USD_PER_1M_TOKENS;
    await expect(quoteCall(body, chat, "USDC")).rejects.toBeInstanceOf(PaymentError);
    process.env.BRAIN_PRICE_USD_PER_1M_TOKENS = "1";
    process.env.BRAIN_PAYMENTS = "off";
    await expect(quoteCall(body, chat, "USDC")).rejects.toMatchObject({ code: "payments_off" });
  });

  it("redeems a paid quote once, binds it to the body, and counts it as a sale", async () => {
    const q = await quoteCall(body, chat, "SOL", 1_000_000);
    chain.tx = solTx(q.baseUnits, q.memo);
    await expect(redeemCall(q.id, SIG, { ...body, max_tokens: 500 }, 1_100_000)).rejects.toMatchObject({ code: "bad_signature" });
    const r = await redeemCall(q.id, SIG, { ...body, pay: "sol" }, 1_100_000);
    expect(r.status).toBe("redeemed");
    expect(r.payer).toBe(PAYER);
    expect(r.confirmedAt).toBe(1_100_000);
    await expect(redeemCall(q.id, SIG, body, 1_200_000)).rejects.toMatchObject({ code: "signature_used" });
    // The same signature cannot pay for a second quote.
    const q2 = await quoteCall(body, chat, "SOL", 1_000_000);
    chain.tx = solTx(q2.baseUnits, q2.memo);
    await expect(redeemCall(q2.id, SIG, body, 1_200_000)).rejects.toMatchObject({ code: "signature_used" });
    await attachCallResult(q.id, "o-1", "r-1");
    expect((await getCallQuote(q.id))?.orderId).toBe("o-1");
    const sales = await confirmedSales(1_000_000, 2_000_000);
    expect(sales).toHaveLength(1);
    expect(salesPool(sales, 0.6, null).salesLamports).toBe(Math.floor(q.baseUnits * 0.6));
  });

  it("rejects wrong memo, underpayment and unconfirmed transactions", async () => {
    const q = await quoteCall(body, chat, "SOL", 1_000_000);
    chain.tx = solTx(q.baseUnits, "brain:call_other");
    await expect(redeemCall(q.id, SIG, body, 1_100_000)).rejects.toMatchObject({ code: "memo_missing" });
    chain.tx = solTx(Math.floor(q.baseUnits / 2), q.memo);
    await expect(redeemCall(q.id, SIG, body, 1_100_000)).rejects.toMatchObject({ code: "underpaid" });
    chain.tx = null;
    await expect(redeemCall(q.id, SIG, body, 1_100_000)).rejects.toMatchObject({ code: "tx_not_found" });
    expect((await getCallQuote(q.id))?.status).toBe("pending");
  });
});
