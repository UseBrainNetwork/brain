import { nodeRoute } from "@/api/http";
import { executionProviders } from "@/engine/providers";
import { assessCapabilities } from "@/services/capability";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export const GET = nodeRoute(async () => {
  const [caps, health] = await Promise.all([assessCapabilities(), Promise.all(executionProviders().map((p) => p.health()))]);
  return json({ ...caps, providers: health, source: "REAL" });
});
