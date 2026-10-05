import { networkConfig } from "@/lib/config";
import type { StoredNode } from "./store";

const { alpha, banBelow, minJobsBeforeBan } = networkConfig.reputation;

/** EWMA reputation. Failures weigh double: lying must cost more than honesty earns. */
export function updateReputation(node: StoredNode, ok: boolean): StoredNode {
  const target = ok ? 1 : 0;
  const a = ok ? alpha : alpha * 2;
  const reputation = node.reputation * (1 - a) + target * a;
  const next: StoredNode = {
    ...node,
    reputation,
    verifiedJobs: node.verifiedJobs + (ok ? 1 : 0),
    failedJobs: node.failedJobs + (ok ? 0 : 1),
  };
  const total = next.verifiedJobs + next.failedJobs;
  if (total >= minJobsBeforeBan && reputation < banBelow) {
    next.status = "banned";
    next.banReason = "reputation-below-threshold";
  }
  return next;
}
