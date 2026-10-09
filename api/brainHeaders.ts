import "server-only";
import type { BrainRunSummary } from "./chatStream";
import { getNativeNode } from "@/services/coordinator/registry";

/**
 * Optional response headers for the public API. Only facts the server holds: the request id, the
 * anonymous node id that produced a native-network answer, that node's coarse operator-chosen
 * region label, measured latency, and the receipt id. Never provider credentials, IPs or wallets.
 */
export async function brainHeaders(requestId: string, s: BrainRunSummary | null, receiptNodes: string[] = []): Promise<Record<string, string>> {
  const h: Record<string, string> = { "brain-request-id": requestId };
  if (!s) return h;
  if (s.target) h["brain-target"] = s.target;
  h["brain-latency"] = String(s.latencyMs);
  if (s.receiptId) {
    h["x-brain-receipt"] = s.receiptId;
    h["x-brain-receipt-url"] = `https://brainnetwork.app/api/receipts/${encodeURIComponent(s.receiptId)}/verify`;
  }
  const nodeId = receiptNodes[0];
  if (nodeId && s.target === "NATIVE_NETWORK") {
    h["brain-node-id"] = nodeId;
    const n = await getNativeNode(nodeId).catch(() => null);
    if (n?.region) h["brain-region"] = n.region;
  }
  return h;
}
