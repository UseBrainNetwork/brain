import { nodeRoute } from "@/api/http";
import { NodeError } from "@/services/nodes";
import { rewardsSummary } from "@/services/rewardsSummary";
import { json } from "@/services/security";
import { isSolanaAddress } from "@/services/wallet";

export const dynamic = "force-dynamic";

/** Public: allocations are published per epoch anyway, so a wallet's ledger is not secret. */
export const GET = nodeRoute(async (req) => {
  const address = new URL(req.url).searchParams.get("address") ?? "";
  if (!isSolanaAddress(address)) throw new NodeError("invalid_address");
  return json(await rewardsSummary(address));
}, 60);
