import { SIGNED_HEADERS } from "../protocol";
import type { Identity } from "./identity";

/**
 * Transport between the node and the coordinator. Outbound only: the node never listens on a
 * port, so operators need no port forwarding. Every message is signed by the node identity.
 *
 * V1 ships `HttpTransport`: signed HTTPS requests plus a long-poll for work (`/work` is held open
 * by the coordinator for up to 20 s). The interface is message-oriented so a persistent-connection
 * transport can replace it without touching the agent: `WebSocketTransport` (coordinator pushes
 * work and receives progress over one socket, planned behind an edge relay since the coordinator
 * itself runs serverless) and later QUIC. The agent only ever calls `call()`.
 */
export interface Transport {
  readonly kind: "http" | "websocket" | "quic";
  call<T>(path: string, body: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  /** Last measured round trip, ms. */
  rttMs(): number | null;
}

export class TransportError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`${status} ${code}`);
  }
}

export class HttpTransport implements Transport {
  readonly kind = "http" as const;
  private rtt: number | null = null;
  constructor(
    private baseUrl: string,
    private id: Identity,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  rttMs() {
    return this.rtt;
  }

  async call<T>(path: string, body: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    const url = new URL(path, `${this.baseUrl}/`);
    const text = JSON.stringify(body ?? {});
    const ts = Date.now();
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000);
    const t0 = performance.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", [SIGNED_HEADERS.node]: this.id.nodeId, [SIGNED_HEADERS.ts]: String(ts), [SIGNED_HEADERS.sig]: this.id.sign("POST", url.pathname, ts, text) },
        body: text,
        signal: ctl.signal,
      });
      // RTT only from short calls; a long poll measures the wait, not the network.
      if (!path.endsWith("/work")) this.rtt = Math.round(performance.now() - t0);
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new TransportError(res.status, typeof j.error === "string" ? j.error : JSON.stringify(j.error ?? "error"));
      return j as T;
    } finally {
      clearTimeout(t);
    }
  }
}
