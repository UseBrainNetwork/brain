import { nodeRoute } from "@/api/http";
import { json } from "@/services/security";
import { getStore } from "@/services/store";
import { PgStore } from "@/services/pgStore";

export const dynamic = "force-dynamic";

/**
 * Database health, aggregate only: sizes, dead rows, connections, slow statements. No row data, no
 * hostnames, no credentials. Public so anyone can see what the store looks like when the site is slow.
 */
export const GET = nodeRoute(async () => {
  const store = getStore();
  if (!(store instanceof PgStore)) return json({ backend: "memory" });
  const t0 = Date.now();
  const d = await store.diagnostics();
  return json({ backend: "postgres", at: Date.now(), tookMs: Date.now() - t0, ...d }, { headers: { "cache-control": "no-store" } });
}, 20);
