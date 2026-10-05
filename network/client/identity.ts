"use client";

/**
 * Anonymous persistent node identity. Generated once per browser profile and kept in
 * localStorage. `id` is what the network displays; `proof` is a random secret the server
 * only ever sees hashed, so this browser (and nobody else) can reclaim its id later.
 * Contains no IP, wallet or personal information.
 */
export interface NodeIdentity {
  id: string;
  proof: string;
}

const KEY = "brain.node.identity.v1";

function hex(bytes: number) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function loadIdentity(): NodeIdentity {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? "") as NodeIdentity;
    if (/^[0-9A-F]{4,6}$/.test(j.id) && /^[0-9a-f]{32,128}$/.test(j.proof)) return j;
  } catch {
    /* fall through */
  }
  const fresh = { id: hex(3).toUpperCase(), proof: hex(32) };
  localStorage.setItem(KEY, JSON.stringify(fresh));
  return fresh;
}

/** The server may have assigned a different id (collision). Remember it for next time. */
export function adoptId(id: string) {
  const cur = loadIdentity();
  if (cur.id !== id) localStorage.setItem(KEY, JSON.stringify({ ...cur, id }));
}
