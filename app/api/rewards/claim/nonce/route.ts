import { body, nodeRoute } from "@/api/http";
import { issueClaim } from "@/services/claims";
import { NodeError } from "@/services/nodes";
import { json } from "@/services/security";
import { isSolanaAddress } from "@/services/wallet";

export const dynamic = "force-dynamic";

export const POST = nodeRoute(async (req) => {
  const { address } = await body<{ address: string }>(req);
  if (!isSolanaAddress(String(address))) throw new NodeError("invalid_address");
  return json(await issueClaim(address));
}, 10);
