import { body, nodeRoute } from "@/api/http";
import { authNode, joinNetwork, linkWallet } from "@/services/nodes";
import { bearer, json } from "@/services/security";
import { getHoldings, verifyLinkToken } from "@/services/wallet";

export const dynamic = "force-dynamic";

/** Optional `linkToken` re-links a previously verified wallet (see issueLinkToken). */
export const POST = nodeRoute(async (req) => {
  let node = await authNode(bearer(req));
  const { linkToken } = await body<{ linkToken?: string }>(req);
  const address = linkToken ? verifyLinkToken(linkToken) : null;
  if (address && !node.walletVerified) {
    await linkWallet(node, address, (await getHoldings(address)).amount);
    node = await authNode(bearer(req));
  }
  return json({ node: await joinNetwork(node) });
}, 20);
