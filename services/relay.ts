import "server-only";
import WebSocket from "ws";
import { decodeFrame, encodeFrame, signTicket, type DoneMsg, type FailMsg, type GatewayInbound, type LapMsg, type LapStage, type PresenceNode, type StageMsg } from "@/inference/protocol";

/**
 * Gateway side of the inference relay (relay/src/index.ts, a Cloudflare Durable Object per model).
 * Configured by BRAIN_RELAY_URL (https://brain-relay.<account>.workers.dev) and BRAIN_RELAY_SECRET,
 * the HMAC key tickets are signed with. Without both, network inference reports no capacity: there
 * is no second transport to fall back to and no pretending otherwise.
 */

export function relayConfig(): { url: string; secret: string } | null {
  const url = process.env.BRAIN_RELAY_URL?.replace(/\/+$/, "");
  const secret = process.env.BRAIN_RELAY_SECRET;
  return url && secret ? { url, secret } : null;
}

export const relayConfigured = () => relayConfig() !== null;

const wsUrl = (http: string) => http.replace(/^http/, "ws");

/** Ticket + URL a node uses to connect its stage to the relay. Valid for `ttlMs`. */
export async function nodeRelayTicket(nodeId: string, model: string, stage: number, ttlMs = 6 * 60 * 60_000): Promise<{ url: string; exp: number } | null> {
  const cfg = relayConfig();
  if (!cfg) return null;
  const exp = Date.now() + ttlMs;
  const ticket = await signTicket({ role: "node", model, nodeId, stage, exp }, cfg.secret);
  return { url: `${wsUrl(cfg.url)}/ws/node?model=${encodeURIComponent(model)}&ticket=${ticket}`, exp };
}

async function gatewayTicket(model: string, cfg: { secret: string }): Promise<string> {
  return signTicket({ role: "gateway", model, exp: Date.now() + 10 * 60_000 }, cfg.secret);
}

const presenceCache = new Map<string, { at: number; value: Promise<PresenceNode[]> }>();

/** Nodes currently connected to the relay for a model (their stage is loaded and serving). Cached 2 s. */
export async function relayPresence(model: string): Promise<PresenceNode[]> {
  const cfg = relayConfig();
  if (!cfg) return [];
  const hit = presenceCache.get(model);
  if (hit && Date.now() - hit.at < 2_000) return hit.value;
  const value = (async () => {
    const ticket = await gatewayTicket(model, cfg);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4_000);
    try {
      const r = await fetch(`${cfg.url}/presence?model=${encodeURIComponent(model)}`, { headers: { authorization: `Bearer ${ticket}` }, signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error(`relay presence ${r.status}`);
      const j = (await r.json()) as { nodes: PresenceNode[] };
      return j.nodes;
    } finally {
      clearTimeout(t);
    }
  })();
  presenceCache.set(model, { at: Date.now(), value });
  value.catch(() => presenceCache.delete(model));
  return value;
}

export interface LapResult {
  /** Top-k payload from the head stage, [seq] columns. */
  topk: Uint8Array;
  /** Relay-side ms for the lap. */
  ms: number;
}

/**
 * One gateway WebSocket per chat session. `lap` sends a batch of token ids through the pipeline
 * and resolves with the head stage's top-k; per-node reports arrive through `onStage` as they
 * happen (the primary's result, the replica's result with the comparison, failures).
 */
export class RelaySession {
  private ws: WebSocket;
  private open: Promise<void>;
  private waiting = new Map<number, { resolve: (r: LapResult) => void; reject: (e: Error) => void }>();
  private closed = false;

  private constructor(
    url: string,
    readonly model: string,
    readonly session: string,
    private onStage: (m: StageMsg) => void,
  ) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.ws.binaryType = "arraybuffer";
    this.open = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("relay connect timeout")), 8_000);
      this.ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.once("error", (e) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
    this.ws.on("message", (data) => this.onMessage(data as ArrayBuffer | Buffer));
    this.ws.on("close", () => {
      this.closed = true;
      for (const w of this.waiting.values()) w.reject(new Error("relay connection closed"));
      this.waiting.clear();
    });
    this.ws.on("error", () => {});
  }

  static async connect(model: string, session: string, onStage: (m: StageMsg) => void): Promise<RelaySession> {
    const cfg = relayConfig();
    if (!cfg) throw new Error("relay not configured");
    const ticket = await gatewayTicket(model, cfg);
    const s = new RelaySession(`${wsUrl(cfg.url)}/ws/gateway?model=${encodeURIComponent(model)}&ticket=${ticket}`, model, session, onStage);
    await s.open;
    return s;
  }

  private onMessage(data: ArrayBuffer | Buffer): void {
    let frame;
    try {
      frame = decodeFrame<GatewayInbound>(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } catch {
      return;
    }
    const h = frame.header;
    if (h.session !== this.session) return;
    if (h.t === "stage") this.onStage(h);
    else if (h.t === "done") {
      const w = this.waiting.get((h as DoneMsg).step);
      if (w) {
        this.waiting.delete(h.step);
        w.resolve({ topk: frame.payload.slice(), ms: (h as DoneMsg).ms });
      }
    } else if (h.t === "fail") {
      const w = this.waiting.get(h.step);
      if (w) {
        this.waiting.delete(h.step);
        w.reject(new Error(`stage ${(h as FailMsg).stage} failed: ${(h as FailMsg).reason}`));
      }
    }
  }

  lap(step: number, plan: LapStage[], tokens: Uint32Array, positions: number[], cacheLen: number, hopMs: number, signal?: AbortSignal): Promise<LapResult> {
    if (this.closed) return Promise.reject(new Error("relay connection closed"));
    const msg: LapMsg = { t: "lap", session: this.session, step, plan, seq: tokens.length, positions, cacheLen, hopMs };
    return new Promise<LapResult>((resolve, reject) => {
      const total = hopMs * plan.length + 3_000;
      const timer = setTimeout(() => {
        this.waiting.delete(step);
        reject(new Error("lap timeout"));
      }, total);
      const onAbort = () => {
        clearTimeout(timer);
        this.waiting.delete(step);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(step, {
        resolve: (r) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      this.ws.send(encodeFrame(msg, new Uint8Array(tokens.buffer, tokens.byteOffset, tokens.byteLength)), (err) => {
        if (err) this.waiting.get(step)?.reject(err);
      });
    });
  }

  /** Tell the relay the session is over so nodes free their caches, then close. */
  end(): void {
    if (this.closed) return;
    try {
      this.ws.send(encodeFrame({ t: "end", session: this.session }));
    } catch {
      /* closing anyway */
    }
    setTimeout(() => this.ws.close(), 200);
  }
}
