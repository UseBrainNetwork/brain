import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./store";
import { createAccount, expirePlanIfDue, getAccount } from "./accounts";
import { balance, ensureMonthlyGrant } from "./credits";
import { PaymentError, type ParsedPaymentTx, type PaymentIntent, priceFor, verifyParsedTx } from "./payments";
import { combineQuotes } from "./solPrice";
import { HOLDER_GRACE_MS, activatePaid, refreshHolder } from "./subscriptions";
import { PLAN_PERIOD_MS, planById } from "@/lib/plans";

vi.mock("server-only", () => ({}));
vi.mock("./solPrice", async (orig) => {
  const m = (await orig()) as typeof import("./solPrice");
  return { ...m, solUsd: vi.fn(async () => ({ usd: 100, source: "coinbase+jupiter" as const, at: 0 })) };
});
const holdings = vi.hoisted(() => ({ amount: 0, provenance: "live" as "live" | "simulated" }));
vi.mock("./wallet", async (orig) => {
  const m = (await orig()) as typeof import("./wallet");
  return { ...m, getHoldings: vi.fn(async (address: string) => ({ address, amount: holdings.amount, supplyShare: 0, provenance: holdings.provenance })) };
});

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };
const TO = "HZLev74M3ATV5jQJsoN8FcJAKx3RUefAobhcXr3egxwa";
const PAYER = "M65EFcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAt0";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const intent = (over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: "pay_abc",
  accountId: "acc_000000000000",
  plan: "PRO",
  currency: "SOL",
  amountUsd: 20,
  amount: 0.2,
  baseUnits: 200_000_000,
  to: TO,
  createdAt: 1_000_000,
  expiresAt: 2_000_000,
  status: "pending",
  source: "REAL",
  ...over,
});

const solTx = (lamportsIn: number, over: Partial<ParsedPaymentTx> = {}): ParsedPaymentTx => ({
  blockTime: 1_000,
  meta: { err: null, preBalances: [1_000_000_000, 5_000], postBalances: [1_000_000_000 - lamportsIn - 5000, 5_000 + lamportsIn] },
  transaction: {
    message: {
      accountKeys: [
        { pubkey: PAYER, signer: true },
        { pubkey: TO, signer: false },
      ],
      instructions: [{ program: "system", programId: "11111111111111111111111111111111" }, { program: "spl-memo", programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: "brain:pay_abc" }],
    },
  },
  ...over,
});

describe("payment verification", () => {
  it("accepts an exact SOL transfer with the intent memo and names the payer", () => {
    expect(verifyParsedTx(intent(), solTx(200_000_000))).toEqual({ payer: PAYER });
  });
  it("accepts overpayment and a 0.2 % rounding shortfall, rejects real underpayment", () => {
    expect(verifyParsedTx(intent(), solTx(250_000_000)).payer).toBe(PAYER);
    expect(verifyParsedTx(intent(), solTx(199_700_000)).payer).toBe(PAYER);
    expect(() => verifyParsedTx(intent(), solTx(150_000_000))).toThrow(PaymentError);
    try {
      verifyParsedTx(intent(), solTx(150_000_000));
    } catch (e) {
      expect((e as PaymentError).code).toBe("underpaid");
    }
  });
  it("rejects a transfer without this intent's memo (someone else's payment)", () => {
    const tx = solTx(200_000_000);
    tx.transaction.message.instructions = [tx.transaction.message.instructions[0]];
    expect(() => verifyParsedTx(intent(), tx)).toThrow(/does not reference/);
    const other = solTx(200_000_000);
    other.transaction.message.instructions[1].parsed = "brain:pay_zzz";
    expect(() => verifyParsedTx(intent(), other)).toThrow(/does not reference/);
  });
  it("rejects failed, missing, mis-addressed and too-old transactions", () => {
    expect(() => verifyParsedTx(intent(), null)).toThrow(/not confirmed/);
    expect(() => verifyParsedTx(intent(), solTx(200_000_000, { meta: { ...solTx(1).meta, err: { InstructionError: [0, "x"] } } }))).toThrow(/failed on chain/);
    const wrong = solTx(200_000_000);
    wrong.transaction.message.accountKeys[1] = { pubkey: "7TSAzUKLyCPb5AqzXUPMy4mTwVj4sdng2Gu2omSsaxVF", signer: false };
    expect(() => verifyParsedTx(intent(), wrong)).toThrow(/does not pay/);
    expect(() => verifyParsedTx(intent(), solTx(200_000_000, { blockTime: 1 }))).toThrow(/predates/);
  });
  it("verifies a USDC transfer from token balance deltas owned by the protocol wallet", () => {
    const i = intent({ currency: "USDC", amount: 20, baseUnits: 20_000_000 });
    const tx = solTx(0);
    tx.meta.preTokenBalances = [{ accountIndex: 3, mint: USDC, owner: TO, uiTokenAmount: { amount: "1000000" } }];
    tx.meta.postTokenBalances = [{ accountIndex: 3, mint: USDC, owner: TO, uiTokenAmount: { amount: "21000000" } }];
    expect(verifyParsedTx(i, tx, USDC).payer).toBe(PAYER);
    tx.meta.postTokenBalances = [{ accountIndex: 3, mint: USDC, owner: TO, uiTokenAmount: { amount: "11000000" } }];
    expect(() => verifyParsedTx(i, tx, USDC)).toThrow(/underpaid|was 10.00 USDC/);
    tx.meta.postTokenBalances = [{ accountIndex: 3, mint: USDC, owner: PAYER, uiTokenAmount: { amount: "99000000" } }];
    expect(() => verifyParsedTx(i, tx, USDC)).toThrow(/does not pay USDC/);
  });
});

describe("pricing", () => {
  it("USDC is exact; SOL uses the live quote rounded up to a micro-SOL", async () => {
    const pro = planById("PRO");
    expect(await priceFor(pro, "USDC")).toEqual({ amount: 20, baseUnits: 20_000_000 });
    const sol = await priceFor(pro, "SOL");
    expect(sol.quote?.usd).toBe(100);
    expect(sol.baseUnits).toBe(200_000_000);
    expect(sol.amount * 100).toBeGreaterThanOrEqual(20);
  });
  it("two sources must agree within 2 %, the lower wins; one source alone is used; none is null", () => {
    expect(combineQuotes(100, 101, 0)).toEqual({ usd: 100, source: "coinbase+jupiter", at: 0 });
    expect(combineQuotes(100, 110, 0)).toBeNull();
    expect(combineQuotes(null, 110, 0)?.source).toBe("jupiter");
    expect(combineQuotes(null, null, 0)).toBeNull();
  });
});

describe("plans from payments and holdings", () => {
  beforeEach(() => {
    g.__brainStore = new MemoryStore();
    holdings.amount = 0;
    holdings.provenance = "live";
  });

  it("a confirmed payment grants the plan's credits once and starts a 30-day period; the same intent cannot activate twice", async () => {
    const a = await createAccount();
    await ensureMonthlyGrant(a, 10);
    const i = intent({ accountId: a.accountId, status: "confirmed", signature: "s".repeat(88) });
    await activatePaid(a, i, 1_000);
    expect(a.plan).toBe("PRO");
    expect(a.planBasis).toBe("paid");
    expect(a.planUntil).toBe(1_000 + PLAN_PERIOD_MS);
    let b = await balance(a.accountId);
    expect(b.granted).toBe(500 + 20_000);
    await activatePaid(a, i, 2_000);
    expect(a.planUntil).toBe(1_000 + PLAN_PERIOD_MS);
    b = await balance(a.accountId);
    expect(b.granted).toBe(500 + 20_000);
  });

  it("paying again for the same plan extends from the current end; a different plan starts fresh", async () => {
    const a = await createAccount();
    await activatePaid(a, intent({ id: "pay_1", accountId: a.accountId, status: "confirmed" }), 1_000);
    await activatePaid(a, intent({ id: "pay_2", accountId: a.accountId, status: "confirmed" }), 5_000);
    expect(a.planUntil).toBe(1_000 + 2 * PLAN_PERIOD_MS);
    await activatePaid(a, intent({ id: "pay_3", accountId: a.accountId, plan: "MAX", amountUsd: 100, status: "confirmed" }), 9_000);
    expect(a.plan).toBe("MAX");
    expect(a.planUntil).toBe(9_000 + PLAN_PERIOD_MS);
  });

  it("a paid plan does not also receive the monthly grant, and lapses to FREE after its period", async () => {
    const a = await createAccount();
    await activatePaid(a, intent({ accountId: a.accountId, status: "confirmed" }), 1_000);
    expect(await ensureMonthlyGrant(a, 2_000)).toMatchObject({ credits: 500 });
    const b = await balance(a.accountId);
    expect(b.granted).toBe(20_500);
    await expirePlanIfDue(a, 1_000 + PLAN_PERIOD_MS - 1);
    expect(a.plan).toBe("PRO");
    await expirePlanIfDue(a, 1_000 + PLAN_PERIOD_MS + 1);
    expect(a.plan).toBe("FREE");
    expect(a.planBasis).toBeUndefined();
    expect((await getAccount(a.accountId))?.plan).toBe("FREE");
  });

  it("holder access: live balance above the threshold unlocks the best plan, below reverts, simulated never counts", async () => {
    process.env.BRAIN_PLAN_PRO_HOLD_TOKENS = "1000";
    process.env.BRAIN_PLAN_MAX_HOLD_TOKENS = "5000";
    try {
      const a = await createAccount();
      a.wallet = TO;
      holdings.amount = 1500;
      let r = await refreshHolder(a, 10_000);
      expect(r.unlocks?.id).toBe("PRO");
      expect(a.plan).toBe("PRO");
      expect(a.planBasis).toBe("holder");
      expect(a.planUntil).toBe(10_000 + HOLDER_GRACE_MS);
      // Holder plans get the monthly allowance, less what FREE already granted this month.
      await ensureMonthlyGrant(a, 10);
      expect((await balance(a.accountId)).granted).toBe(20_000);
      holdings.amount = 6000;
      r = await refreshHolder(a, 11_000);
      expect(a.plan).toBe("MAX");
      holdings.amount = 10;
      r = await refreshHolder(a, 12_000);
      expect(a.plan).toBe("FREE");
      holdings.amount = 999_999;
      holdings.provenance = "simulated";
      r = await refreshHolder(a, 13_000);
      expect(r.balance).toBeNull();
      expect(a.plan).toBe("FREE");
    } finally {
      delete process.env.BRAIN_PLAN_PRO_HOLD_TOKENS;
      delete process.env.BRAIN_PLAN_MAX_HOLD_TOKENS;
    }
  });

  it("holder access never downgrades an active paid plan of equal or higher rank", async () => {
    process.env.BRAIN_PLAN_PRO_HOLD_TOKENS = "1000";
    try {
      const a = await createAccount();
      a.wallet = TO;
      await activatePaid(a, intent({ accountId: a.accountId, plan: "MAX", amountUsd: 100, status: "confirmed" }), 1_000);
      holdings.amount = 2000;
      await refreshHolder(a, 2_000);
      expect(a.plan).toBe("MAX");
      expect(a.planBasis).toBe("paid");
    } finally {
      delete process.env.BRAIN_PLAN_PRO_HOLD_TOKENS;
    }
  });
});
