import { body, nodeRoute } from "@/api/http";
import { json } from "@/services/security";
import { adapterStatuses, manualAdapter, rescanTreasury, syncedTreasury, syncTreasury, withChainBalances } from "@/services/treasury";

export const dynamic = "force-dynamic";
/** A rescan reads every protocol-wallet transaction (one RPC call each). */
export const maxDuration = 60;

export const GET = nodeRoute(async () => json({ treasury: await syncedTreasury(), adapters: adapterStatuses() }));

/**
 * Operator-only.
 *   { action: "rescan" }              rebuild the chain-side ledger from the protocol wallet's full history
 *   { amountSol, reference, at? }     record a real creator-reward receipt by transaction signature
 */
export const POST = nodeRoute(async (req) => {
  const token = process.env.BRAIN_ADMIN_TOKEN;
  if (!token || req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
  const b = await body<{ action?: string; amountSol?: number; reference?: string; at?: number }>(req);
  if (b.action === "rescan") return json({ treasury: await rescanTreasury(), adapters: adapterStatuses() });
  try {
    manualAdapter.add(Number(b.amountSol), String(b.reference ?? ""), b.at ? Number(b.at) : undefined);
  } catch (e) {
    return json({ error: "invalid_request", message: e instanceof Error ? e.message : "" }, 400);
  }
  return json({ treasury: await withChainBalances(await syncTreasury(manualAdapter)) }, 201);
}, 10);
