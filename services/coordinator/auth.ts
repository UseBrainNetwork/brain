import "server-only";
import { createPublicKey, verify } from "node:crypto";
import { NODE_ID_RE, SIGNATURE_TTL_MS, SIGNED_HEADERS, signingString } from "@/node/protocol";
import { NodeError } from "@/services/nodes";
import { sha256 } from "@/services/security";

/**
 * Node authentication: every coordinator request carries an ed25519 signature over
 * method + path + timestamp + body hash (see node/protocol.ts). The public key is bound to the node
 * id at registration; the id itself is derived from the key, so a node cannot claim another's id.
 * There is no shared secret anywhere. Nothing a node sends is trusted beyond "this came from the
 * holder of this key".
 */

const DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const nodeIdFor = (publicKeyB64: string) => `N-${sha256(`brain-node-id|${publicKeyB64}`).slice(0, 8).toUpperCase()}`;

export function verifyNodeSignature(publicKeyB64: string, method: string, pathname: string, ts: number, bodyText: string, signatureB64: string): boolean {
  try {
    const raw = Buffer.from(publicKeyB64, "base64");
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([DER_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(signingString(method, pathname, ts, sha256(bodyText)), "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export interface SignedRequest {
  nodeId: string;
  publicKey: string;
  ts: number;
  signature: string;
  bodyText: string;
  pathname: string;
  method: string;
}

/** Pulls the signed envelope off a request. Throws 401 if any header is missing or malformed. */
export async function readSigned(req: Request, maxBytes = 256 * 1024): Promise<SignedRequest & { body: Record<string, unknown> }> {
  const nodeId = req.headers.get(SIGNED_HEADERS.node) ?? "";
  const ts = Number(req.headers.get(SIGNED_HEADERS.ts));
  const signature = req.headers.get(SIGNED_HEADERS.sig) ?? "";
  if (!NODE_ID_RE.test(nodeId) || !Number.isFinite(ts) || !signature) throw new NodeError("unauthenticated", 401);
  if (Math.abs(Date.now() - ts) > SIGNATURE_TTL_MS) throw new NodeError("signature_expired", 401);
  const bodyText = await req.text();
  if (bodyText.length > maxBytes) throw new NodeError("payload_too_large", 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText || "{}");
  } catch {
    throw new NodeError("invalid_json", 400);
  }
  return { nodeId, publicKey: "", ts, signature, bodyText, pathname: new URL(req.url).pathname, method: req.method, body };
}

/* Replay guard: a signature is accepted once per instance within its TTL. */
const seen = new Map<string, number>();
export function checkReplay(nodeId: string, signature: string, now = Date.now()): boolean {
  if (seen.size > 20_000) for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  const k = `${nodeId}:${signature}`;
  if ((seen.get(k) ?? 0) > now) return false;
  seen.set(k, now + SIGNATURE_TTL_MS);
  return true;
}

/** Verifies the envelope against a known public key. */
export function authenticateSigned(s: SignedRequest, publicKey: string) {
  if (!verifyNodeSignature(publicKey, s.method, s.pathname, s.ts, s.bodyText, s.signature)) throw new NodeError("bad_signature", 401);
  if (!checkReplay(s.nodeId, s.signature)) throw new NodeError("replayed", 401);
}
