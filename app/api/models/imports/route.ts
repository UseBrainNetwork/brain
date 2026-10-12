import { nodeRoute } from "@/api/http";
import { lastKnownGood } from "@/services/failsoft";
import { importedModelsView } from "@/services/modelImports";
import { sharedJson } from "@/services/security";

export const dynamic = "force-dynamic";

/** GET /api/models/imports — the imported-model table with how many nodes serve each right now. */
export const GET = nodeRoute(async () => {
  const s = await lastKnownGood("models.imports", 10_000, () => importedModelsView());
  return sharedJson({ ...s.body, asOf: s.asOf, stale: s.stale }, 10);
});
