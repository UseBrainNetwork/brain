import { nodeRoute } from "@/api/http";
import { coordinatorPublicKey, receiptHash, verifyReceipt } from "@/services/coordinator/receipts";
import { getReceipt } from "@/services/receipts";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

/**
 * GET /api/receipts/<id>/verify — anyone can check a receipt without trusting this server's word:
 * the response carries the canonical body that was hashed, the hash recomputed now, the signature,
 * and the coordinator's current public key, so the same check can be repeated offline.
 *
 * Browser-pool and upstream receipts are unsigned (attestation.kind = "none") and say so; their
 * `resultHash` is an integrity digest over verified unit outputs, not a signature.
 */
export const GET = nodeRoute(async (req) => {
  const parts = new URL(req.url).pathname.split("/");
  const id = decodeURIComponent(parts[parts.length - 2] ?? "");
  const r = await getReceipt(id);
  if (!r) return json({ error: "not_found" }, 404);
  const signed = r.attestation.kind === "signature";
  const result = signed ? verifyReceipt(r) : { ok: false, reason: r.attestation.kind === "anchor" ? "anchored receipts are not verified here yet" : "unsigned" };
  return json(
    {
      receiptId: r.receiptId,
      source: r.source,
      status: r.status,
      verificationMethod: r.verificationMethod,
      attestation: r.attestation,
      signed,
      valid: result.ok,
      reason: result.reason ?? null,
      canonical: r.canonical ? { body: r.canonical.body, storedHash: r.canonical.hash, recomputedHash: receiptHash(r.canonical.body) } : null,
      /** Raw 32-byte ed25519 public key, base64. A receipt signed by an earlier key carries that key in `attestation.signer`. */
      coordinatorPublicKey: coordinatorPublicKey(),
      howTo: "sha256(canonicalJson(canonical.body)) must equal storedHash; ed25519_verify(attestation.signer, bytes(storedHash as hex), attestation.signature) must hold.",
    },
    { headers: { "cache-control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } },
  );
}, 120);
