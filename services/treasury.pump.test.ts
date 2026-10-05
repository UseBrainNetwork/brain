import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pump.fun adapter must only record SOL that left a creator-fee vault into the protocol wallet.
 * Plain inbound transfers, swaps and failed transactions must never become creator revenue.
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

const chain: Record<string, unknown> = {
  [SIG_AMM]: tx([WALLET, AMM_WSOL, CREATOR_WSOL, AMM], [1e9, 27.002e9, 0.002e9, 0], [0.999e9, 0.002e9, 27.002e9, 0], [AMM]),
  // Claim: vault loses 2 SOL, wallet gains 2 SOL, pump program invoked.
  [SIG_CLAIM]: tx([WALLET, VAULT, PUMP, SYS], [1e9, 2.5e9, 0, 0], [3e9, 0.5e9, 0, 0], [PUMP]),
  // Plain inbound transfer from someone else: no vault, no pump.
  [SIG_PLAIN]: tx([WALLET, "SomeoneE1se1111111111111111111111111111111111", SYS], [1e9, 5e9, 0], [1.08e9, 4.92e9, 0], [SYS]),
};

describe("PumpFunCreatorRewardAdapter", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.BRAIN_TOKEN_MINT = "FiJ4gnd4dhqNeBKfS4E8wnERMEpjMPdUfJhu8foipump";
    process.env.NEXT_PUBLIC_BRAIN_TOKEN_MINT = process.env.BRAIN_TOKEN_MINT;
    process.env.SOLANA_RPC_URL = "http://rpc.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        let result: unknown;
        if (method === "getSignaturesForAddress") result = [{ signature: SIG_FAIL, blockTime: 4, err: { x: 1 } }, { signature: SIG_AMM, blockTime: 3, err: null }, { signature: SIG_PLAIN, blockTime: 2, err: null }, { signature: SIG_CLAIM, blockTime: 1, err: null }];
        else if (method === "getTransaction") result = chain[params[0] as string] ?? null;
        else throw new Error(`unexpected ${method}`);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("records only vault→wallet claims, by signature, and advances its cursor", async () => {
    const { pumpAdapter, syncTreasury, getTreasury } = await import("./treasury");
    const { getStore } = await import("./store");
    const before = await getTreasury("REAL");
    const t = await syncTreasury(pumpAdapter);
    expect(t.received - before.received).toBeCloseTo(29, 9);
    expect(t.references).toContain(SIG_CLAIM);
    expect(t.references).toContain(SIG_AMM);
    expect(t.references).not.toContain(SIG_PLAIN);
    expect(t.references).not.toContain(SIG_FAIL);
    const cursor = await getStore().getDoc<{ signature: string }>("treasury", "pumpfun:cursor");
    expect(cursor?.signature).toBe(SIG_FAIL);
    // Throttled: a second poll inside a minute reads nothing and changes nothing.
    const again = await syncTreasury(pumpAdapter);
    expect(again.received).toBe(t.received);
    expect(pumpAdapter.status().ok).toBe(true);
  });
});
