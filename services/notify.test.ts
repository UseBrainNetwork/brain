import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RewardAllocation, RewardEpoch } from "@/domain/types";
import { clearWalletNotify, notifySettled, setWalletNotify, settledEmail, unsubscribeToken, validEmail, walletFromUnsubscribeToken } from "./notify";
import { MemoryStore } from "./store";

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };
const W1 = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const W2 = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

const epoch: RewardEpoch = { id: "ep-1", startsAt: Date.UTC(2026, 9, 5, 14), endsAt: Date.UTC(2026, 9, 5, 15), poolLamports: 1e9, distributedLamports: 3e8, participants: 2, totalVerifiedCompute: 5000, settledAt: Date.now(), provenance: "live" };
const alloc = (wallet: string, lamports: number): RewardAllocation => ({ epochId: "ep-1", wallet, lamports, verifiedCompute: 1200, jobsAssigned: 10, jobsCompleted: 9, availability: 0.9, multiplier: 1, quality: 1, computeShare: 0.3, capped: false, provenance: "live" });

describe("payout notifications", () => {
  const env = process.env;
  beforeEach(() => {
    g.__brainStore = new MemoryStore();
    process.env = { ...env, BRAIN_SERVER_SECRET: "test-secret-test-secret-test-secret" };
    delete process.env.RESEND_API_KEY;
  });
  afterEach(() => {
    process.env = env;
    vi.restoreAllMocks();
  });

  it("validates emails and round-trips unsubscribe tokens", () => {
    expect(validEmail("a@b.co")).toBe(true);
    expect(validEmail("nope")).toBe(false);
    expect(validEmail(42)).toBe(false);
    const t = unsubscribeToken(W1);
    expect(walletFromUnsubscribeToken(t)).toBe(W1);
    expect(walletFromUnsubscribeToken(`${W1}.deadbeef`)).toBeNull();
    expect(walletFromUnsubscribeToken("garbage")).toBeNull();
  });

  it("is a no-op without RESEND_API_KEY", async () => {
    await setWalletNotify(W1, "Delivered@resend.dev", "privy");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await notifySettled(epoch, [alloc(W1, 1e8)]);
    expect(r).toEqual({ sent: 0, skipped: "unconfigured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("emails only opted-in wallets that were actually allocated something; idempotent per epoch", async () => {
    process.env.RESEND_API_KEY = "re_test";
    await setWalletNotify(W1, "Delivered@resend.dev", "privy");
    await setWalletNotify(W2, "other@resend.dev", "manual");
    await clearWalletNotify(W2);
    const calls: { url: string; init: RequestInit }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const r = await notifySettled(epoch, [alloc(W1, 1e8), alloc(W2, 1e8), alloc("3rdWalletNoPrefs11111111111111111111111111", 5e7)]);
    expect(r).toEqual({ sent: 1, skipped: null, error: undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails/batch");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("batch-epoch-settled/ep-1/0");
    expect(headers.authorization).toBe("Bearer re_test");
    const body = JSON.parse(String(calls[0].init.body)) as { to: string[]; subject: string; text: string }[];
    expect(body[0].to).toEqual(["delivered@resend.dev"]);
    expect(body[0].subject).toContain("0.1000 SOL");
    expect(body[0].text).toContain("/api/wallet/email/unsubscribe?t=");
    expect(body[0].text).toContain("no return is promised");
  });

  it("zero-lamport allocations never produce an email", async () => {
    process.env.RESEND_API_KEY = "re_test";
    await setWalletNotify(W1, "delivered@resend.dev", "privy");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await notifySettled(epoch, [alloc(W1, 0)]);
    expect(r).toEqual({ sent: 0, skipped: "no_recipients" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("email body states the facts from the allocation", () => {
    const m = settledEmail(W1, epoch, { ...alloc(W1, 123_000_000), capped: true });
    expect(m.text).toContain("2026-10-05 14:00 UTC");
    expect(m.text).toContain("Allocated: 0.1230 SOL");
    expect(m.text).toContain("Verified compute: 1,200 units");
    expect(m.text).toContain("Per-wallet cap applied");
    expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https?:\/\//);
  });
});
