import { chatCompletion, validateChat } from "@/api/gateway";
import { body, nodeRoute } from "@/api/http";
import { networkConfig } from "@/lib/config";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

/** In-site playground. Same gateway as /v1, tighter rate limit, no API key needed. */
export const POST = nodeRoute(async (req) => {
  const req2 = validateChat(await body(req, 64 * 1024));
  return json(await chatCompletion(req2));
}, networkConfig.rateLimit.inferenceRequests);
