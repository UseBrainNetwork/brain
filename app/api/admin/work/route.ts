import { createHash, timingSafeEqual } from "node:crypto";
import { nodeRoute } from "@/api/http";
import { NodeError } from "@/services/nodes";
import { bearer, json } from "@/services/security";
import { epochAt, epochLengthMs, epochWorkReport } from "@/services/settlement";

export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const given = bearer(req);
  const token = process.env.BRAIN_ADMIN_TOKEN;
  if (!given || !token) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(token), h(given));
}

/**
 * Operator-only. Which nodes did work in an epoch, whether each has a linked wallet, and how the pool
 * splits. `?epoch=current` (default), `last`, an ISO time, or epoch ms inside the wanted epoch.
 * Wallet addresses are included; this must never be exposed without the admin token.
 */
export const GET = nodeRoute(async (req) => {
  if (!authorized(req)) throw new NodeError("unauthorized", 401);
  const q = new URL(req.url).searchParams.get("epoch") ?? "current";
  const now = Date.now();
  const at = q === "current" ? now : q === "last" ? now - epochLengthMs() : /^\d+$/.test(q) ? Number(q) : Date.parse(q);
  if (!Number.isFinite(at)) throw new NodeError("invalid_epoch");
  return json(await epochWorkReport(epochAt(at).startsAt, now));
}, 30);
