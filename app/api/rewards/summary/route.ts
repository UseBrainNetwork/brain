import { after } from "next/server";
import { nodeRoute } from "@/api/http";
import { NodeError } from "@/services/nodes";
import { rewardsSummary } from "@/services/rewardsSummary";
import { settleDueEpochs } from "@/services/settlement";
import { json } from "@/services/security";
import { isSolanaAddress } from "@/services/wallet";

export const dynamic = "force-dynamic";

/** Public: allocations are published per epoch anyway, so a wallet's ledger is not secret. */
export const GET = nodeRoute(async (req) => {
  const address = new URL(req.url).searchParams.get("address") ?? "";
  if (!isSolanaAddress(address)) throw new NodeError("invalid_address");
  // Opportunistic settlement after the response is sent: any closed epoch with work gets settled, so
  // claimable SOL appears within a refresh of the epoch closing. Never on the request's critical path.
  after(() => settleDueEpochs().catch(() => []));
  return json(await rewardsSummary(address));
}, 60);
