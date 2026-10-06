import { body, nodeRoute } from "@/api/http";
import { submitHop } from "@/services/inference";
import { authNode } from "@/services/nodes";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";

/** Hop result: base64 f32 hidden state for the stage's output, or an error. Up to 4 MB (long prefills). */
export const POST = nodeRoute(async (req) => {
  const node = await authNode(bearer(req));
  const b = await body<{ hopId?: string; output?: string; gpuMs?: number; error?: string }>(req, 4 * 1024 * 1024);
  if (typeof b.hopId !== "string") return json({ error: "missing_hop" }, 400);
  const r = await submitHop(node, b.hopId, { output: typeof b.output === "string" ? b.output : undefined, gpuMs: Number(b.gpuMs) || 0, error: typeof b.error === "string" ? b.error : undefined });
  return json(r);
}, 2_000);
