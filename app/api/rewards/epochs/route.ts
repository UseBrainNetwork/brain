import { nodeRoute } from "@/api/http";
import { epochAt, epochLengthMs } from "@/services/settlement";
import { sharedJson } from "@/services/security";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

/**
 * Settled hourly reward epochs, newest first. Public fields only: no wallets, no per-wallet
 * allocations. Lets anyone check that settlement is running and what each hour distributed.
 */
export const GET = nodeRoute(async (req) => {
  const limit = Math.min(100, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 48));
  const epochs = await getStore().listEpochs(limit);
  const now = Date.now();
  const len = epochLengthMs();
  const lastClosed = epochAt(now - len);
  return sharedJson(
    {
      source: "REAL",
      epochMinutes: Math.round(len / 60_000),
      current: { id: epochAt(now).id, startsAt: epochAt(now).startsAt },
      lastClosed: { id: lastClosed.id, startsAt: lastClosed.startsAt, settled: epochs.some((e) => e.id === lastClosed.id) },
      epochs: epochs.map((e) => ({
        id: e.id,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        settledAt: e.settledAt,
        poolLamports: e.poolLamports,
        distributedLamports: e.distributedLamports,
        participants: e.participants,
        totalVerifiedCompute: e.totalVerifiedCompute,
        provenance: e.provenance,
      })),
    },
    15,
  );
});
