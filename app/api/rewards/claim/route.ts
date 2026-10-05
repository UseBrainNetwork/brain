import { body, nodeRoute } from "@/api/http";
import { claim } from "@/services/claims";
import { NodeError } from "@/services/nodes";
import { json } from "@/services/security";
import { isSolanaAddress } from "@/services/wallet";

export const dynamic = "force-dynamic";

/** Pays the signer's own claimable balance to the signer's own wallet. Nothing else is accepted. */
export const POST = nodeRoute(async (req) => {
  const b = await body<{ address: string; message: string; signature: string }>(req, 8 * 1024);
  if (!isSolanaAddress(String(b.address))) throw new NodeError("invalid_address");
  return json({ claim: await claim(b.address, String(b.message), String(b.signature)) });
}, 10);
