import { nodeRoute } from "@/api/http";
import { NodeError } from "@/services/nodes";
import { json } from "@/services/security";
import { getHoldings, isSolanaAddress } from "@/services/wallet";

export const dynamic = "force-dynamic";

/** Public holdings lookup (on-chain balances are public). Does NOT link a wallet to a node. */
export const GET = nodeRoute(async (req) => {
  const address = new URL(req.url).searchParams.get("address") ?? "";
  if (!isSolanaAddress(address)) throw new NodeError("invalid_address");
  return json({ holding: await getHoldings(address) });
}, 60);
