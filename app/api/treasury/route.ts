import { body, nodeRoute } from "@/api/http";
import { json } from "@/services/security";
import { adapterStatuses, getTreasury, manualAdapter, syncTreasury } from "@/services/treasury";

export const dynamic = "force-dynamic";

export const GET = nodeRoute(async () => json({ treasury: await getTreasury("REAL"), adapters: adapterStatuses() }));

/** Operator-only: record a real creator-reward receipt by transaction signature. */
export const POST = nodeRoute(async (req) => {
  const token = process.env.BRAIN_ADMIN_TOKEN;
  if (!token || req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
  const b = await body<{ amountSol?: number; reference?: string; at?: number }>(req);
  try {
    manualAdapter.add(Number(b.amountSol), String(b.reference ?? ""), b.at ? Number(b.at) : undefined);
  } catch (e) {
    return json({ error: "invalid_request", message: e instanceof Error ? e.message : "" }, 400);
  }
  return json({ treasury: await syncTreasury(manualAdapter) }, 201);
}, 10);
