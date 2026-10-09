import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { concentrationOf } from "./concentration";
import type { StoredNode } from "./store";

const node = (ipHash: string, wallet: string | null, compute = 1): StoredNode =>
  ({ id: ipHash + wallet + Math.random(), ipHash, walletAddress: wallet ?? undefined, walletVerified: wallet != null, verifiedComputeUnits: compute, status: "idle" }) as unknown as StoredNode;

describe("concentration", () => {
  it("groups live nodes by address and wallet and publishes only aggregates", () => {
    const nodes = [
      ...Array.from({ length: 12 }, () => node("ipA", "W1", 10)), // one person, twelve tabs, one wallet
      node("ipB", "W2", 5),
      node("ipB", "W3", 5), // household: same address, two wallets
      node("ipC", null, 1),
      node("ipD", "W4", 1),
    ];
    const c = concentrationOf(nodes);
    expect(c.nodesOnline).toBe(16);
    expect(c.byAddress).toMatchObject({ groups: 4, largest: 12, tenPlus: { groups: 1, nodes: 12 }, sizes: { "1": 2, "2-5": 1, "6-20": 1, "21-100": 0, "100+": 0 } });
    expect(c.byAddress.top5Share).toBe(1);
    expect(c.wallets).toMatchObject({ groups: 4, largest: 12, linkedNodes: 15, unlinkedNodes: 1 });
    expect(c.computeShareLargestWallet).toBeCloseTo(120 / 132, 6);
    expect(JSON.stringify(c)).not.toMatch(/ipA|W1/);
  });

  it("is well-defined on an empty fleet", () => {
    const c = concentrationOf([]);
    expect(c.byAddress).toMatchObject({ groups: 0, largest: 0, top5Share: 0 });
    expect(c.computeShareLargestWallet).toBeNull();
  });
});
