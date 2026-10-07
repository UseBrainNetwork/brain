import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base58Encode } from "./wallet";

vi.mock("server-only", () => ({}));

/**
 * The pump.fun adapter must only record SOL that left a creator-fee vault into the protocol wallet as
 * creator revenue. Plain inbound transfers, swaps and failed transactions must never become creator
 * revenue; outflows are classified as payout-wallet funding or withdrawals so the ledger can be
 * reconciled against chain balances.
 */
const WALLET = "HZLev74M3ATV5jQJsoN8FcJAKx3RUefAobhcXr3egxwa";
const VAULT = "C3yRmkmh3gKpUKH8y7StKsMEWU3ipjSsY8Wnioh6qqfH";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SYS = "11111111111111111111111111111111";
const SIG_CLAIM = "3fHnJUhCruhyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
const SIG_PLAIN = "pFEDF259MNmQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2";
const SIG_FAIL = "4kPYpG6rQkw5AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3";

function tx(keys: string[], pre: number[], post: number[], programs: string[]) {
  return { transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })), instructions: programs.map((programId) => ({ programId })) } }, meta: { preBalances: pre, postBalances: post, innerInstructions: [] } };
}

// PumpSwap (post-graduation) claim: 27 WSOL leaves the AMM vault's WSOL account, creator's own WSOL account gains it.
const AMM_WSOL = "49CLiczvAzzBXWrWwmmosm5R5nrUsTVQ635mdLG5ob9t";
const CREATOR_WSOL = "J4eSe7rkfmSVivBrrSwPjDQqLvhgnYjQqWXib3esgpD6";
const AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const SIG_AMM = "7ammC1aimAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4";

// Outflows: 5 SOL to the payout wallet (funding), 10 SOL somewhere else (withdrawal). The payout wallet
// is recognised from the configured payout key, so make a real keypair for it.
const payoutKp = generateKeyPairSync("ed25519");
const payoutSeed = payoutKp.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const payoutPub = payoutKp.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const PAYOUT_SECRET = JSON.stringify([...payoutSeed, ...payoutPub]);
const PAYOUT = base58Encode(payoutPub);
const SIG_FUND = "5fundPay0utAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5";
const SIG_OUT = "6w1thdrawAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA6";

const chain: Record<string, unknown> = {
  [SIG_AMM]: tx([WALLET, AMM_WSOL, CREATOR_WSOL, AMM], [1e9, 27.002e9, 0.002e9, 0], [0.999e9, 0.002e9, 27.002e9, 0], [AMM]),
  // Claim: vault loses 2 SOL, wallet gains 2 SOL, pump program invoked.
  [SIG_CLAIM]: tx([WALLET, VAULT, PUMP, SYS], [1e9, 2.5e9, 0, 0], [3e9, 0.5e9, 0, 0], [PUMP]),
  // Plain inbound transfer from someone else: no vault, no pump.
  [SIG_PLAIN]: tx([WALLET, "SomeoneE1se1111111111111111111111111111111111", SYS], [1e9, 5e9, 0], [1.08e9, 4.92e9, 0], [SYS]),
  [SIG_FUND]: tx([WALLET, PAYOUT, SYS], [10e9, 1e9, 0], [4.999995e9, 6e9, 0], [SYS]),
  [SIG_OUT]: tx([WALLET, "E1sewhere11111111111111111111111111111111111", SYS], [30e9, 0, 0], [19.999995e9, 10e9, 0], [SYS]),
};
const SIGS = [
  { signature: SIG_FAIL, blockTime: 6, err: { x: 1 } },
  { signature: SIG_OUT, blockTime: 5, err: null },
  { signature: SIG_FUND, blockTime: 4, err: null },
  { signature: SIG_AMM, blockTime: 3, err: null },
  { signature: SIG_PLAIN, blockTime: 2, err: null },
  { signature: SIG_CLAIM, blockTime: 1, err: null },
];

describe("PumpFunCreatorRewardAdapter", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.BRAIN_TOKEN_MINT = "FiJ4gnd4dhqNeBKfS4E8wnERMEpjMPdUfJhu8foipump";
    process.env.NEXT_PUBLIC_BRAIN_TOKEN_MINT = process.env.BRAIN_TOKEN_MINT;
    process.env.SOLANA_RPC_URL = "http://rpc.test";
    process.env.BRAIN_PAYOUT_SECRET_KEY = PAYOUT_SECRET;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        let result: unknown;
        if (method === "getSignaturesForAddress") {
          const opts = (params[1] ?? {}) as { until?: string };
          const stop = opts.until ? SIGS.findIndex((s) => s.signature === opts.until) : SIGS.length;
          result = SIGS.slice(0, stop < 0 ? SIGS.length : stop);
        } else if (method === "getTransaction") result = chain[params[0] as string] ?? null;
        else if (method === "getMultipleAccounts") result = { value: [{ lamports: 0 }, { lamports: 0 }, null, { lamports: 4.3e9 }] };
        else if (method === "getAccountInfo") result = { value: null };
        else throw new Error(`unexpected ${method}`);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BRAIN_PAYOUT_SECRET_KEY;
    delete process.env.BRAIN_EPOCH_POOL_SOL;
  });

  it("classifies every transaction by signature, counts only vault→wallet claims as fees, and advances its cursor", async () => {
    const { pumpAdapter, syncTreasury } = await import("./treasury");
    const { getStore } = await import("./store");
    const t = await syncTreasury(pumpAdapter);
    expect(t.received).toBeCloseTo(29, 9);
    expect(t.deposited).toBeCloseTo(0.08, 9);
    expect(t.payoutFunded).toBeCloseTo(5.000005, 9);
    expect(t.withdrawn).toBeCloseTo(10.000005, 9);
    for (const sig of [SIG_CLAIM, SIG_AMM, SIG_PLAIN, SIG_FUND, SIG_OUT]) expect(t.references).toContain(sig);
    expect(t.references).not.toContain(SIG_FAIL);
    const cursor = await getStore().getDoc<{ signature: string }>("treasury", "pumpfun:cursor");
    expect(cursor?.signature).toBe(SIG_FAIL);
    // Throttled: a second poll inside a minute reads nothing and changes nothing.
    const again = await syncTreasury(pumpAdapter);
    expect(again.received).toBe(t.received);
    expect(pumpAdapter.status().ok).toBe(true);
    // Only one creator-fee accounting event per claim signature.
    const { listEvents } = await import("./accounting");
    const fees = (await listEvents("REAL", 50)).filter((e) => e.type === "CREATOR_REWARD_RECEIVED");
    expect(fees.map((e) => e.transactionReference).sort()).toEqual([SIG_AMM, SIG_CLAIM].sort());
  });

  it("rebuilds from chain history without double-booking fees, and reads balances, what is owed and the runway", async () => {
    process.env.BRAIN_EPOCH_POOL_SOL = "0.15";
    const { pumpAdapter, syncTreasury, rescanTreasury, syncedTreasury } = await import("./treasury");
    const { getStore } = await import("./store");
    const { listEvents } = await import("./accounting");
    await syncTreasury(pumpAdapter);
    // Pretend the stored figures drifted (as a hand-kept ledger would), then rebuild.
    const doc = await getStore().getDoc<Record<string, unknown>>("treasury", "REAL");
    await getStore().putDoc("treasury", "REAL", { ...doc, received: 999, balance: 16.63, allocated: 13.14 }, { at: Date.now(), key: "REAL" });
    const t = await rescanTreasury();
    expect(t.received).toBeCloseTo(29, 9);
    expect(t.payoutFunded).toBeCloseTo(5.000005, 9);
    expect((await listEvents("REAL", 50)).filter((e) => e.type === "CREATOR_REWARD_RECEIVED")).toHaveLength(2);
    // Chain balances and liabilities: no epochs or claims yet, so nothing is owed; runway = payout balance / pool.
    const v = await syncedTreasury();
    expect(v.balance).toBe(0);
    expect(v.payoutWallet).toEqual({ address: PAYOUT, balance: 4.3 });
    expect(v.allocated).toBe(0);
    expect(v.pendingDistribution).toBe(0);
    expect(v.poolPerEpoch).toBe(0.15);
    expect(v.runwayEpochs).toBeCloseTo(4.3 / 0.15, 9);
    // The hand-kept fields are gone for good.
    expect("balance" in ((await getStore().getDoc<Record<string, unknown>>("treasury", "REAL")) ?? {})).toBe(false);
  });
});
