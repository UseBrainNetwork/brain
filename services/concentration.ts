import "server-only";
import type { StoredNode } from "./store";

/**
 * How concentrated the live browser fleet is: nodes per network address and per linked wallet.
 * Aggregates only. No address hash, wallet or node id leaves this function, so the result is
 * safe to publish; it answers "is one person running most of these tabs" without naming anyone.
 *
 * An address cluster is every live node whose requests hashed to the same client address. One
 * household behind one router is one cluster, so a cluster is an upper bound on one person, not
 * proof of one. A wallet cluster is exact: those nodes are paid to the same key.
 */

export interface Cluster {
  /** Distinct groups. */
  groups: number;
  /** Nodes in the largest group. */
  largest: number;
  /** Share of nodes (0..1) in the five largest groups. */
  top5Share: number;
  /** Groups of at least ten nodes, and how many nodes they hold between them. */
  tenPlus: { groups: number; nodes: number };
  /** Histogram of group sizes. */
  sizes: { "1": number; "2-5": number; "6-20": number; "21-100": number; "100+": number };
}

export interface Concentration {
  source: "REAL";
  nodesOnline: number;
  byAddress: Cluster;
  wallets: Cluster & { linkedNodes: number; unlinkedNodes: number };
  /** Share of verified compute (0..1) held by the single largest wallet group, from the nodes' lifetime totals. */
  computeShareLargestWallet: number | null;
}

function cluster(groups: number[]): Cluster {
  const sorted = [...groups].sort((a, b) => b - a);
  const total = sorted.reduce((a, b) => a + b, 0);
  const sizes: Cluster["sizes"] = { "1": 0, "2-5": 0, "6-20": 0, "21-100": 0, "100+": 0 };
  for (const n of sorted) sizes[n === 1 ? "1" : n <= 5 ? "2-5" : n <= 20 ? "6-20" : n <= 100 ? "21-100" : "100+"]++;
  const big = sorted.filter((n) => n >= 10);
  return {
    groups: sorted.length,
    largest: sorted[0] ?? 0,
    top5Share: total ? sorted.slice(0, 5).reduce((a, b) => a + b, 0) / total : 0,
    tenPlus: { groups: big.length, nodes: big.reduce((a, b) => a + b, 0) },
    sizes,
  };
}

export function concentrationOf(nodes: StoredNode[]): Concentration {
  const byIp = new Map<string, number>();
  const byWallet = new Map<string, { n: number; compute: number }>();
  let unlinked = 0;
  let totalCompute = 0;
  for (const n of nodes) {
    byIp.set(n.ipHash || "?", (byIp.get(n.ipHash || "?") ?? 0) + 1);
    totalCompute += n.verifiedComputeUnits;
    if (n.walletVerified && n.walletAddress) {
      const w = byWallet.get(n.walletAddress) ?? { n: 0, compute: 0 };
      w.n++;
      w.compute += n.verifiedComputeUnits;
      byWallet.set(n.walletAddress, w);
    } else unlinked++;
  }
  const wallets = [...byWallet.values()];
  const largestByCompute = wallets.reduce((m, w) => Math.max(m, w.compute), 0);
  return {
    source: "REAL",
    nodesOnline: nodes.length,
    byAddress: cluster([...byIp.values()]),
    wallets: { ...cluster(wallets.map((w) => w.n)), linkedNodes: nodes.length - unlinked, unlinkedNodes: unlinked },
    computeShareLargestWallet: totalCompute > 0 && wallets.length ? largestByCompute / totalCompute : null,
  };
}
