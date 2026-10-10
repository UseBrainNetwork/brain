import { createHash, timingSafeEqual } from "node:crypto";
import { nodeRoute } from "@/api/http";
import { NodeError } from "@/services/nodes";
import { parseSecretKey, solanaPayoutSender } from "@/services/payouts";
import { rpc } from "@/services/solana";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TEMPORARY, operator-only, removed after use. Sweeps the payout wallet's entire SOL balance to a
 * single fixed destination (payouts are moving to an external script). Gated by a one-time token
 * that is unset together with this route. The payout key never leaves the function.
 */
const DESTINATION = "38g4DgV4xH3tt9rqQSyH3YtG9LDEN67Jp94UN7tBQ6iH";
const EXPECTED_FROM = "7TSAzUKLyCPb5AqzXUPMy4mTwVj4sdng2Gu2omSsaxVF";
const FEE = 5_000;

function authorized(req: Request): boolean {
  const given = bearer(req);
  const token = process.env.BRAIN_SWEEP_TOKEN;
  if (!given || !token) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(token), h(given));
}

export const POST = nodeRoute(async (req) => {
  if (!authorized(req)) throw new NodeError("unauthorized", 401);
  const url = process.env.SOLANA_RPC_URL;
  const raw = process.env.BRAIN_PAYOUT_SECRET_KEY;
  if (!url || !raw) throw new NodeError("payout_wallet_not_configured", 503);
  const sender = solanaPayoutSender(url, parseSecretKey(raw));
  if (sender.address !== EXPECTED_FROM) throw new NodeError("unexpected_payout_address", 409);
  const { value: balance } = await rpc<{ value: number }>(url, "getBalance", [sender.address, { commitment: "confirmed" }]);
  const lamports = balance - FEE;
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  if (lamports <= 0) return json({ from: sender.address, to: DESTINATION, balanceSol: balance / 1e9, sent: false, reason: "nothing to sweep" });
  if (dry) return json({ from: sender.address, to: DESTINATION, balanceSol: balance / 1e9, wouldSendSol: lamports / 1e9, sent: false, dry: true });
  const signature = await sender.send(DESTINATION, lamports);
  let status: "confirmed" | "failed" | "unknown" = "unknown";
  for (let i = 0; i < 20 && status === "unknown"; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    status = await sender.status(signature);
  }
  const { value: after } = await rpc<{ value: number }>(url, "getBalance", [sender.address, { commitment: "confirmed" }]);
  return json({ from: sender.address, to: DESTINATION, sentSol: lamports / 1e9, signature, status, balanceAfterSol: after / 1e9, explorer: `https://solscan.io/tx/${signature}` });
}, 5);
