import "server-only";
import { networkConfig } from "@/lib/config";
import { NodeError } from "@/services/nodes";
import { ipHash, json, rateLimit, tooMany } from "@/services/security";
import { GatewayError } from "./gateway";

type Handler = (req: Request, ctx: { ip: string }) => Promise<Response>;

/** Wraps a route: rate limit by hashed IP, JSON errors, no stack traces leak. */
export function nodeRoute(handler: Handler, limit: number = networkConfig.rateLimit.nodeRequests): (req: Request) => Promise<Response> {
  return async (req) => {
    const ip = ipHash(req);
    if (!rateLimit(`${new URL(req.url).pathname}:${ip}`, limit).ok) return tooMany();
    try {
      return await handler(req, { ip });
    } catch (e) {
      if (e instanceof NodeError) return json({ error: e.code }, e.status);
      if (e instanceof GatewayError) {
        return json({ error: { code: e.code, message: e.message } }, e.status);
      }
      console.error(e);
      return json({ error: "internal_error" }, 500);
    }
  };
}

export async function body<T = Record<string, unknown>>(req: Request, maxBytes = 512 * 1024): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new NodeError("payload_too_large", 413);
  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    throw new NodeError("invalid_json", 400);
  }
}
