import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { signingString } from "../protocol";

/**
 * Persistent node identity: an ed25519 keypair stored in BRAIN_NODE_HOME (default ~/.brain-node).
 * The node id is derived from the public key the same way the coordinator derives it, so neither
 * side can be talked into a different id. Losing the file means a new node id and a fresh history.
 */
export interface Identity {
  nodeId: string;
  publicKey: string;
  home: string;
  sign(method: string, pathname: string, ts: number, bodyText: string): string;
}

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export const nodeIdFor = (publicKeyB64: string) => `N-${createHash("sha256").update(`brain-node-id|${publicKeyB64}`).digest("hex").slice(0, 8).toUpperCase()}`;

export function loadIdentity(home = process.env.BRAIN_NODE_HOME || join(homedir(), ".brain-node")): Identity {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, "identity.json");
  let seed: Buffer;
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { seed: string };
    seed = Buffer.from(j.seed, "base64");
    if (seed.length !== 32) throw new Error("bad seed");
  } catch {
    const { privateKey } = generateKeyPairSync("ed25519");
    const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
    seed = der.subarray(der.length - 32);
    writeFileSync(file, JSON.stringify({ v: 1, seed: seed.toString("base64") }), { mode: 0o600 });
  }
  const priv: KeyObject = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32).toString("base64");
  return {
    nodeId: nodeIdFor(publicKey),
    publicKey,
    home,
    sign: (method, pathname, ts, bodyText) => sign(null, Buffer.from(signingString(method, pathname, ts, createHash("sha256").update(bodyText).digest("hex")), "utf8"), priv).toString("base64"),
  };
}
