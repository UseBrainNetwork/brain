import { body, nodeRoute } from "@/api/http";
import { pathParam } from "@/services/coordinator/http";
import { linkNativeWallet, publicNativeNode } from "@/services/coordinator/registry";
import { NodeError } from "@/services/nodes";
import { json } from "@/services/security";
import { verifyLinkToken } from "@/services/wallet";

export const dynamic = "force-dynamic";

/**
 * POST /api/coordinator/nodes/<id>/link { linkToken }
 *
 * Proves the operator wallet of a native GPU node. The link token comes from /api/wallet/verify
 * (a wallet signature over a server nonce); the node must already have reported the same address.
 * Until this succeeds the node's work is recorded but accrues nothing.
 */
export const POST = nodeRoute(async (req) => {
  const id = pathParam(req, 2).toUpperCase();
  const b = await body<{ linkToken?: string }>(req);
  const address = typeof b.linkToken === "string" ? verifyLinkToken(b.linkToken) : null;
  if (!address) throw new NodeError("bad_link_token", 401);
  const n = await linkNativeWallet(id, address);
  // The node view route caches for 10 s; the dashboard refetches right after linking.
  (globalThis as typeof globalThis & { __brainNNodeView?: Map<string, unknown> }).__brainNNodeView?.delete(id);
  return json({ node: publicNativeNode(n) });
}, 30);
