import { body, nodeRoute } from "@/api/http";
import { NodeError } from "@/services/nodes";
import { clearWalletNotify, emailConfigured, getWalletNotify, maskEmail, setWalletNotify, validEmail } from "@/services/notify";
import { json } from "@/services/security";
import { verifyLinkToken } from "@/services/wallet";

export const dynamic = "force-dynamic";

const shape = (n: Awaited<ReturnType<typeof getWalletNotify>>) => ({ on: Boolean(n?.optIn), email: n?.optIn ? maskEmail(n.email) : null, source: n?.optIn ? n.source : null, optedOut: Boolean(n && !n.optIn), configured: emailConfigured() });

/** Payout-email preference for a wallet. Proof of wallet ownership is the link token from /api/wallet/verify. */
export const GET = nodeRoute(async (req) => {
  const t = new URL(req.url).searchParams.get("linkToken");
  const wallet = t ? verifyLinkToken(t) : null;
  if (!wallet) throw new NodeError("bad_link_token", 401);
  return json(shape(await getWalletNotify(wallet)));
}, 60);

export const POST = nodeRoute(async (req) => {
  const b = await body<{ linkToken: string; email: string; source?: "privy" | "manual" }>(req);
  const wallet = verifyLinkToken(String(b.linkToken));
  if (!wallet) throw new NodeError("bad_link_token", 401);
  if (!validEmail(b.email)) throw new NodeError("invalid_email");
  const n = await setWalletNotify(wallet, b.email, b.source === "privy" ? "privy" : "manual");
  return json(shape(n));
}, 20);

export const DELETE = nodeRoute(async (req) => {
  const b = await body<{ linkToken: string }>(req);
  const wallet = verifyLinkToken(String(b.linkToken));
  if (!wallet) throw new NodeError("bad_link_token", 401);
  await clearWalletNotify(wallet);
  return json(shape(await getWalletNotify(wallet)));
}, 20);
