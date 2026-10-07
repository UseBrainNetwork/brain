import { coordinatorPublicKey } from "@/services/coordinator/receipts";
import { sharedJson } from "@/services/security";

/** GET /api/coordinator/signer — the ed25519 public key that signs Brain Compute Receipts (raw 32 bytes, base64). */
export async function GET() {
  return sharedJson({ algorithm: "ed25519", publicKey: coordinatorPublicKey(), hash: "sha256 over canonical JSON (sorted keys)" }, 60);
}
