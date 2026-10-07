import { nodeRoute } from "@/api/http";
import { DEFAULTS, type RegisterBody } from "@/node/protocol";
import { authenticateSigned, readSigned } from "@/services/coordinator/auth";
import { getNativeNode, registerNativeNode } from "@/services/coordinator/registry";
import { NodeError } from "@/services/nodes";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

/**
 * POST /api/coordinator/register — a native Brain Node announces itself. The request is signed
 * with the key it is registering, so the binding key → id is proven on first contact. A known node
 * must sign with its bound key; a different key for the same id is refused.
 */
export const POST = nodeRoute(async (req, { ip }) => {
  const s = await readSigned(req, 64 * 1024);
  const body = s.body as unknown as RegisterBody;
  const known = await getNativeNode(s.nodeId);
  const key = known?.publicKey ?? (typeof body.publicKey === "string" ? body.publicKey : "");
  if (!key) throw new NodeError("bad_public_key", 400);
  authenticateSigned(s, key);
  if (body.protocol !== 1) throw new NodeError("unsupported_protocol", 426);
  const n = await registerNativeNode(body, ip);
  return json({ nodeId: n.nodeId, state: n.state, heartbeatMs: DEFAULTS.heartbeatMs, workPollMs: DEFAULTS.workPollMs, acceptedModels: n.reported.capabilities.supportedModels });
}, 60);
