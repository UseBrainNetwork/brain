import { describe, expect, it, vi } from "vitest";
import type { RewardClaim, RewardEpoch } from "@/domain/types";
import { MemoryStore } from "./store";
import { bucketByDay, poolComposition } from "./payoutsPage";

vi.mock("server-only", () => ({}));

const claim = (over: Partial<RewardClaim>): RewardClaim => ({ id: Math.random().toString(36).slice(2), wallet: "W1", lamports: 1_000_000, status: "sent", createdAt: 0, updatedAt: 0, txSignature: "sig", ...over });

describe("payouts page data", () => {
  it("buckets paid claims by UTC day, oldest first, with empty days kept", () => {
    const now = Date.UTC(2026, 9, 8, 1);
    const d = bucketByDay([claim({ createdAt: Date.UTC(2026, 9, 8, 0, 30), lamports: 5 }), claim({ createdAt: Date.UTC(2026, 9, 6, 23, 59), lamports: 7 }), claim({ createdAt: Date.UTC(2026, 9, 1), lamports: 99 })], 3, now);
    expect(d.map((x) => x.day)).toEqual(["2026-10-06", "2026-10-07", "2026-10-08"]);
    expect(d.map((x) => x.lamports)).toEqual([7, 0, 5]);
    expect(d.map((x) => x.payouts)).toEqual([1, 0, 1]);
  });

  it("totals count only sent/confirmed claims; pending and failed never count as paid", async () => {
    const s = new MemoryStore();
    await s.insertClaim(claim({ wallet: "A", lamports: 10, status: "sent", createdAt: 100 }));
    await s.insertClaim(claim({ wallet: "A", lamports: 20, status: "confirmed", createdAt: 200 }));
    await s.insertClaim(claim({ wallet: "B", lamports: 40, status: "failed", createdAt: 300 }));
    await s.insertClaim(claim({ wallet: "C", lamports: 80, status: "pending", createdAt: 400 }));
    expect(await s.paidClaimTotals()).toEqual({ lamports: 30, count: 2, wallets: 1, firstAt: 100, lastAt: 200 });
    expect((await s.listPaidClaims(10)).map((c) => c.lamports)).toEqual([20, 10]);
    expect(await new MemoryStore().paidClaimTotals()).toEqual({ lamports: 0, count: 0, wallets: 0, firstAt: null, lastAt: null });
  });
});

describe("poolComposition", () => {
  const H = 3600_000;
  const epoch = (i: number, pool?: RewardEpoch["pool"]): RewardEpoch => ({ id: `E-${i}`, startsAt: i * H, endsAt: (i + 1) * H, poolLamports: 150_000_000 + (pool?.salesLamports ?? 0), distributedLamports: 1, participants: 1, totalVerifiedCompute: 1, settledAt: (i + 1) * H, provenance: "live", ...(pool ? { pool } : {}) });
  const src = (salesLamports: number, purchases: number): NonNullable<RewardEpoch["pool"]> => ({ fixedLamports: 150_000_000, salesLamports, salesUsd: purchases * 20, purchases, share: 0.6, solUsd: 100 });

  it("treats epochs without a pool record as fixed and finds the first sales-majority hour", () => {
    const c = poolComposition([epoch(2, src(200_000_000, 3)), epoch(1, src(10_000_000, 1)), epoch(0)]);
    expect(c.fixedLamports).toBe(450_000_000);
    expect(c.salesLamports).toBe(210_000_000);
    expect(c.salesUsd).toBe(80);
    expect(c.purchases).toBe(4);
    expect(c.epochsWithSales).toBe(2);
    expect(c.epochs).toBe(3);
    expect(c.firstSalesMajority).toBe("E-2");
    expect(c.latest).toEqual({ id: "E-2", fixedLamports: 150_000_000, salesLamports: 200_000_000, purchases: 3 });
  });

  it("reports no majority and no sales when nothing has been bought", () => {
    const c = poolComposition([epoch(1), epoch(0)]);
    expect(c.salesLamports).toBe(0);
    expect(c.firstSalesMajority).toBeNull();
    expect(c.latest?.id).toBe("E-1");
  });
});
