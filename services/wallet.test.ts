import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { base58Encode, issueNonce, verifySignature } from "./wallet";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const address = base58Encode(new Uint8Array(spki.subarray(spki.length - 32)));
  const signMsg = (m: string) => sign(null, Buffer.from(m, "utf8"), privateKey).toString("base64");
  return { address, signMsg };
}

describe("wallet link nonce", () => {
  it("verifies a signed nonce with no server-side state (nonce and verify may hit different instances)", () => {
    const { address, signMsg } = keypair();
    const message = issueNonce(address);
    expect(message).toMatch(/^BRAIN node link\n\nWallet: /);
    // Nothing is stored between issue and verify; a fresh instance has only the shared secret.
    expect(verifySignature(address, message, signMsg(message))).toBe(true);
  });

  it("rejects a replay, a tampered message, another wallet's nonce and a bad signature", () => {
    const a = keypair();
    const b = keypair();
    const message = issueNonce(a.address);
    const sig = a.signMsg(message);
    expect(verifySignature(a.address, message, sig)).toBe(true);
    expect(verifySignature(a.address, message, sig)).toBe(false);
    const m2 = issueNonce(a.address);
    expect(verifySignature(a.address, m2.replace("moves no funds", "moves funds"), a.signMsg(m2))).toBe(false);
    expect(verifySignature(b.address, m2, b.signMsg(m2))).toBe(false);
    expect(verifySignature(a.address, m2, b.signMsg(m2))).toBe(false);
    const forged = m2.replace(/Nonce: [0-9a-f]{16}\.[0-9a-f]{16}/, "Nonce: 0000000000000000.0000000000000000");
    expect(verifySignature(a.address, forged, a.signMsg(forged))).toBe(false);
  });

  it("expires after five minutes", () => {
    const { address, signMsg } = keypair();
    const message = issueNonce(address);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 6 * 60_000);
      expect(verifySignature(address, message, signMsg(message))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
