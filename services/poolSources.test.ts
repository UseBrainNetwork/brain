import { afterEach, describe, expect, it } from "vitest";
import type { PaymentIntent } from "./payments";
import { PoolSourcesError, salesPool, salesShare } from "./poolSources";

const buy = (over: Partial<PaymentIntent>): PaymentIntent => ({
  id: "pay-1",
  accountId: "a",
  plan: "PRO",
  currency: "USDC",
  amountUsd: 20,
  amount: 20,
  baseUnits: 20_000_000,
  to: "7TSA",
  createdAt: 0,
  expiresAt: 1,
  status: "confirmed",
  confirmedAt: 1,
  source: "REAL",
  ...over,
});

describe("sales side of the epoch pool", () => {
  afterEach(() => {
    delete process.env.BRAIN_POOL_SALES_SHARE;
  });

  it("counts SOL purchases at their lamports and applies the contributors' share", () => {
    const r = salesPool([buy({ currency: "SOL", amountUsd: 20, amount: 0.1, baseUnits: 100_000_000 })], 0.6, null);
    expect(r).toEqual({ salesLamports: 60_000_000, salesUsd: 20, purchases: 1, share: 0.6, solUsd: null });
  });

  it("converts USDC purchases at the recorded SOL/USD quote, and refuses to settle without one", () => {
    const quote = { usd: 200, source: "coinbase+jupiter" as const, at: 1 };
    const r = salesPool([buy({ amountUsd: 20 }), buy({ id: "pay-2", amountUsd: 100, plan: "MAX" })], 0.6, quote);
    // $120 at $200/SOL = 0.6 SOL; 60 % of that.
    expect(r.salesLamports).toBe(Math.floor(0.6 * 1_000_000_000 * 0.6));
    expect(r).toMatchObject({ salesUsd: 120, purchases: 2, solUsd: 200 });
    expect(() => salesPool([buy({})], 0.6, null)).toThrow(PoolSourcesError);
  });

  it("zero purchases add nothing; the share comes from the revenue split unless overridden", () => {
    expect(salesPool([], 0.6, null).salesLamports).toBe(0);
    expect(salesShare()).toBe(0.6);
    process.env.BRAIN_POOL_SALES_SHARE = "0";
    expect(salesShare()).toBe(0);
    process.env.BRAIN_POOL_SALES_SHARE = "1.5";
    expect(salesShare()).toBe(0.6);
  });
});
