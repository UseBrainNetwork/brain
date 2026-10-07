import type { RoutingMode } from "@/domain/economy";
import { executionProviders, UpstreamExecutionProvider } from "@/engine/providers";
import { DEFAULT_NETWORK_MODEL, MODEL_PREFERENCE } from "@/inference/config";
import { tokenListPricePer1MUsd } from "@/lib/pricing";
import { MODEL_ALLOWLIST } from "@/node/models";
import { routableNativeNodes } from "@/services/coordinator/registry";
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
  // BROWSER_ONLY runs on contributor nodes. The model actually served depends on who is online
  // (largest verifiable in MODEL_PREFERENCE); /api/inference/status reports it live.
  byMode.BROWSER_ONLY = `${MODEL_PREFERENCE.map((m) => m.id).join(" | ")} (contributor nodes; default ${DEFAULT_NETWORK_MODEL.id})`;
  // Community GPUs: machines running the Brain Node agent. Which allowlisted model they serve is
  // read from the live registry, so this is null whenever none is routable, never a guess.
  const nodes = await routableNativeNodes().catch(() => []);
  const served = new Set(nodes.flatMap((n) => n.reported.capabilities.supportedModels));
  const nativeModel = MODEL_ALLOWLIST.find((m) => !m.mock && served.has(m.id)) ?? null;
  const native = { model: nativeModel?.id ?? null, name: nativeModel?.name ?? null, nodes: nativeModel ? nodes.filter((n) => n.reported.capabilities.supportedModels.includes(nativeModel.id)).length : 0, usdPer1MTokens: tokenListPricePer1MUsd() };
  return json(
    { configured, models: byMode, native, filters: "none" as const },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300" } },
  );
}
