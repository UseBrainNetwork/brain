import { body, nodeRoute } from "@/api/http";
import { finalizeEpoch, listEpochsV2 } from "@/services/epochs";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const GET = nodeRoute(async () => json({ epochs: await listEpochsV2(20) }));

/** Operator-only: finalize a closed epoch. Body: { epochStart, poolLamports? | fromTreasury? } */
export const POST = nodeRoute(async (req) => {
  const token = process.env.BRAIN_ADMIN_TOKEN;
  if (!token || req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
  const b = await body<{ epochStart?: number; poolLamports?: number; fromTreasury?: boolean }>(req);
  const r = await finalizeEpoch({ epochStart: Number(b.epochStart), poolLamports: b.poolLamports, fromTreasury: Boolean(b.fromTreasury) });
  return json(r, r.created ? 201 : 200);
}, 10);
