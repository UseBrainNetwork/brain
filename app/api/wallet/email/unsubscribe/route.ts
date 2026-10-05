import { nodeRoute } from "@/api/http";
import { clearWalletNotify, walletFromUnsubscribeToken } from "@/services/notify";

export const dynamic = "force-dynamic";

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#e8e6e1;font:15px/1.5 -apple-system,system-ui,sans-serif}main{max-width:420px;padding:32px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#a8a69f}a{color:#e8e6e1}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

/** One-click unsubscribe target used in every payout email (also the List-Unsubscribe header). */
const handle = nodeRoute(async (req) => {
  const t = new URL(req.url).searchParams.get("t");
  const wallet = t ? walletFromUnsubscribeToken(t) : null;
  if (!wallet) return page("Link not valid", "This unsubscribe link is not valid.", 400);
  await clearWalletNotify(wallet);
  return page("Payout emails off", `No more payout emails for ${wallet.slice(0, 4)}…${wallet.slice(-4)}. Rewards keep accruing exactly as before; see <a href="/rewards">brainnetwork.app/rewards</a>.`);
}, 30);

export const GET = handle;
export const POST = handle;
