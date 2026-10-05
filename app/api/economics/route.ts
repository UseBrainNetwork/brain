import { nodeRoute } from "@/api/http";
import { computeUnitListPriceUsd, tokenListPricePer1MUsd } from "@/lib/pricing";
import { listEvents, snapshot } from "@/services/accounting";
import { realSummary } from "@/services/distributed";
import { listEpochsV2 } from "@/services/epochs";
import { listReceipts } from "@/services/receipts";
import { json } from "@/services/security";
import { adapterStatuses, syncedTreasury } from "@/services/treasury";

export const dynamic = "force-dynamic";

/** REAL economics only. Simulated numbers never appear here. */
export const GET = nodeRoute(async (req) => {
  const from = Number(new URL(req.url).searchParams.get("from")) || 0;
  const receipts = await listReceipts(500);
  const [snap, events, treasury, epochs, network] = await Promise.all([snapshot("REAL", from, undefined, receipts), listEvents("REAL", 50), syncedTreasury(), listEpochsV2(10), realSummary()]);
  return json({
    source: "REAL",
    snapshot: snap,
    events,
    receipts: receipts.slice(0, 20),
    treasury,
    adapters: adapterStatuses(),
    epochs: epochs.map((e) => ({ epochId: e.epochId, startsAt: e.startsAt, endsAt: e.endsAt, poolLamports: e.poolLamports, distributedLamports: e.distributedLamports, participants: e.participants, resultHash: e.resultHash })),
    network,
    pricing: { computeUnitsPer1kUsd: computeUnitListPriceUsd(), tokensPer1MUsd: tokenListPricePer1MUsd() },
  });
});
