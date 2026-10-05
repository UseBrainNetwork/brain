import { body, nodeRoute } from "@/api/http";
import { attachWallet, currentAccount } from "@/services/accounts";
import { authNode, linkWallet, NodeError } from "@/services/nodes";
import { bearer, json } from "@/services/security";
import { getHoldings, isSolanaAddress, issueLinkToken, verifySignature } from "@/services/wallet";

export const dynamic = "force-dynamic";

/** Verifies a signed nonce, returns holdings, links the wallet to the caller's node if any, and attaches it to the caller's account session if any. */
export const POST = nodeRoute(async (req) => {
  const b = await body<{ address: string; message: string; signature: string }>(req);
  if (!isSolanaAddress(String(b.address))) throw new NodeError("invalid_address");
  if (!verifySignature(b.address, String(b.message), String(b.signature))) throw new NodeError("bad_signature", 401);
  const holding = await getHoldings(b.address);
  const session = bearer(req);
  const node = session ? await linkWallet(await authNode(session), b.address, holding.amount) : null;
  const account = await currentAccount(req);
  if (account && account.wallet !== b.address) await attachWallet(account, b.address);
  return json({ verified: true, holding, node, account: account ? { accountId: account.accountId, wallet: b.address } : null, linkToken: issueLinkToken(b.address) });
}, 30);
