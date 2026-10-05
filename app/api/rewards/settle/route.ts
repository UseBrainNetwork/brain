import { createHash, timingSafeEqual } from "node:crypto";
import { body, nodeRoute } from "@/api/http";
import { NodeError } from "@/services/nodes";
import { bearer, json } from "@/services/security";
import { epochAt, epochLengthMs, LAMPORTS_PER_SOL, settleDueEpochs, settleEpoch } from "@/services/settlement";

export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const given = bearer(req);
  const tokens = [process.env.BRAIN_ADMIN_TOKEN, process.env.CRON_SECRET].filter((t): t is string => Boolean(t));
  if (!given || tokens.length === 0) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return tokens.some((t) => timingSafeEqual(h(t), h(given)));
}

async function run(epochStart: number, poolSol?: number) {
  const poolLamports = poolSol != null ? Math.floor(poolSol * LAMPORTS_PER_SOL) : undefined;
  if (poolLamports != null && !(poolLamports >= 0)) throw new NodeError("invalid_pool");
  return json(await settleEpoch({ epochStart, poolLamports }));
}

/**
 * Operator-only. Settles the epoch starting at `epochStart` (default: the last closed epoch).
 * `poolSol` overrides BRAIN_EPOCH_POOL_SOL; without either, the epoch settles as SIMULATED.
 */
export const POST = nodeRoute(async (req) => {
  if (!authorized(req)) throw new NodeError("unauthorized", 401);
  const b = await body<{ epochStart?: number; poolSol?: number }>(req);
  const start = Number.isFinite(b.epochStart) ? Number(b.epochStart) : epochAt(Date.now() - epochLengthMs()).startsAt;
  return run(start, b.poolSol != null ? Number(b.poolSol) : undefined);
}, 10);

/** Vercel Cron entry point (Authorization: Bearer $CRON_SECRET). Settles every closed epoch that has work. */
export const GET = nodeRoute(async (req) => {
  if (!authorized(req)) throw new NodeError("unauthorized", 401);
  const settled = await settleDueEpochs(Date.now() - 31_000);
  return json({ settled: settled.map((e) => ({ id: e.id, poolLamports: e.poolLamports, distributedLamports: e.distributedLamports, participants: e.participants, provenance: e.provenance })) });
}, 10);
