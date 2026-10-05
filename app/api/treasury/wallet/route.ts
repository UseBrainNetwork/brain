import { nodeRoute } from "@/api/http";
import { json } from "@/services/security";
import { getProtocolWallet } from "@/services/protocolWallet";

export const dynamic = "force-dynamic";

/** Public, read-only: the protocol wallet's on-chain balance and recent transfers. REAL or UNKNOWN. */
export const GET = nodeRoute(async () => {
  const res = json(await getProtocolWallet());
  res.headers.set("cache-control", "public, max-age=30, s-maxage=60");
  return res;
}, 60);
