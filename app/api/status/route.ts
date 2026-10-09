import { nodeRoute } from "@/api/http";
import { json } from "@/services/security";
import { statusData } from "@/services/statusPage";

export const dynamic = "force-dynamic";

/**
 * Machine-readable /status. Same measurements as the page, no incident prose. `ok` is true when the
 * database answered and at least one pooler lane is open; outside monitors can key on it.
 */
export const GET = nodeRoute(async () => {
  const d = await statusData();
  const lanesOpen = d.database?.lanes ? d.database.lanes.filter((l) => l.coolingDownSec === 0).length : null;
  const ok = Boolean(d.database?.ok) && (lanesOpen == null || lanesOpen > 0);
  const { incidents, ...rest } = d;
  return json(
    { source: "REAL", ok, ...rest, incidents: incidents.length, latestIncident: incidents[0] ? { date: incidents[0].date, title: incidents[0].title } : null },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "public, max-age=30, s-maxage=30", "Access-Control-Allow-Origin": "*" } },
  );
}, 60);
