import type { RoutingMode } from "@/domain/economy";
import { executionProviders, UpstreamExecutionProvider } from "@/engine/providers";
import { DEFAULT_NETWORK_MODEL } from "@/inference/config";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

/**
 * Which concrete model each routing mode runs on, for the /chat surface. Model ids only; this is
 * the same information every receipt already exposes. Credentials and base URLs never leave the server.
 */
export async function GET() {
  const modes: RoutingMode[] = ["AUTO", "CHEAP", "FAST", "QUALITY"];
  const upstreams = executionProviders().filter((p): p is UpstreamExecutionProvider => p instanceof UpstreamExecutionProvider);
  const byMode: Record<string, string | null> = {};
  for (const m of modes) {
    const p = upstreams.find((u) => u.modelFor(m));
    byMode[m] = p?.modelFor(m) ?? null;
  }
  const configured = Object.values(byMode).some(Boolean);
  // BROWSER_ONLY runs on contributor nodes; the model id is fixed by inference/config.ts.
  byMode.BROWSER_ONLY = `${DEFAULT_NETWORK_MODEL.id} (contributor nodes)`;
  return json(
    { configured, models: byMode, filters: "none" as const },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300" } },
  );
}
