"use client";

import { useSyncExternalStore } from "react";
import { NETWORK_MODELS, nodeFitsStage, type NetworkModel, type StageSpan } from "@/inference/config";
import { decodeFrame, encodeFrame, headColumns, packF16, packTopK, topKOf, unpackF16, type NodeInbound, type ResultMsg } from "@/inference/protocol";
import { loadStageEntries } from "@/inference/shardLoader";
import { LlmStage } from "@/webgpu/llm";

/**
 * The node's inference side: load the model stage the server assigns (weights by range request
 * from the Hugging Face CDN, cached locally), then hold a WebSocket to the relay and serve hops:
 * run the stage's layers over the incoming tokens or hidden state, keep the session's KV cache,
 * send the output back. Runs next to the verification-job loop in network/client/contributor.ts.
 */

export type InferencePhase = "off" | "assigning" | "downloading" | "connecting" | "ready" | "error";

export interface InferenceState {
  enabled: boolean;
  phase: InferencePhase;
  model: string | null;
  modelLabel: string | null;
  params: string | null;
  stage: number | null;
  layers: [number, number] | null;
  stages: number | null;
  hasEmbed: boolean;
  hasHead: boolean;
  /** 0..1 download progress. */
  progress: number;
  downloadBytes: number;
  hops: number;
  tokens: number;
  gpuMs: number;
  sessions: number;
  lastHopAt: number | null;
  /** Connected to the relay and able to take hops. */
  connected: boolean;
  error: string | null;
}

const LS_KEY = "brain.inference.v1";
const MIN_BUFFER_BYTES = 256 * 1024 * 1024;
const SESSION_IDLE_MS = 120_000;
const PING_MS = 30_000;

const initial: InferenceState = {
  enabled: false,
  phase: "off",
  model: null,
  modelLabel: null,
  params: null,
  stage: null,
  layers: null,
  stages: null,
  hasEmbed: false,
  hasHead: false,
  progress: 0,
  downloadBytes: 0,
  hops: 0,
  tokens: 0,
  gpuMs: 0,
  sessions: 0,
  lastHopAt: null,
  connected: false,
  error: null,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Default on for desktop-class browsers; phones opt in (a stage is a 100–400 MB download). */
export function defaultEnabled(): boolean {
  if (typeof navigator === "undefined") return false;
  const stored = localStorage.getItem(LS_KEY);
  if (stored === "on") return true;
  if (stored === "off") return false;
  const uaMobile = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile;
  if (typeof uaMobile === "boolean") return !uaMobile;
  return !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

interface AssignResponse {
  model: Pick<NetworkModel, "id" | "label" | "params" | "repo" | "revision" | "weightsFile" | "license" | "quant" | "config" | "stageLayers" | "maxContext">;
  span: StageSpan;
  state: string;
}

class InferenceWorker {
  private state: InferenceState = initial;
  private listeners = new Set<() => void>();
  private running = false;
  private stage: LlmStage | null = null;
  private abort: AbortController | null = null;
  private token: () => string | null = () => null;
  private maxBufferBytes = 0;
  private ws: WebSocket | null = null;
  /** Hops run one at a time per node; the relay never overlaps them within a session anyway. */
  private queue: Promise<void> = Promise.resolve();

  getSnapshot = () => this.state;
  getServerSnapshot = () => initial;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  private set(p: Partial<InferenceState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  }

  setEnabled(on: boolean) {
    localStorage.setItem(LS_KEY, on ? "on" : "off");
    this.set({ enabled: on });
    if (!on) void this.stop("off");
  }

  /** Called by the contributor engine once the node is registered and running. */
  async start(token: () => string | null, maxBufferBytes: number) {
    this.token = token;
    this.maxBufferBytes = maxBufferBytes;
    const enabled = defaultEnabled();
    this.set({ enabled });
    if (!enabled || this.running) return;
    if (maxBufferBytes && maxBufferBytes < MIN_BUFFER_BYTES) {
      this.set({ phase: "error", error: "This GPU's buffer limit is below what a model stage needs." });
      return;
    }
    this.running = true;
    void this.run();
  }

  async stop(reason: InferencePhase = "off") {
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    this.ws?.close();
    this.ws = null;
    this.stage?.dispose();
    this.stage = null;
    this.set({ phase: reason, progress: 0, sessions: 0, connected: false });
  }

  private async run() {
    try {
      this.set({ phase: "assigning", error: null });
      const a = await this.post<AssignResponse>("/api/inference/assign", {});
      const model: NetworkModel = NETWORK_MODELS[a.model.id] ?? ({ ...a.model, family: "qwen3", tokenizerRepo: a.model.repo, tokenizerFile: "tokenizer.json", stageDownloadBytes: [], stageGpuBytes: [], noThink: true, tier: 9 } as NetworkModel);
      const span = a.span;
      if (this.maxBufferBytes && NETWORK_MODELS[model.id] && !nodeFitsStage(model, span, this.maxBufferBytes)) throw new Error(`This GPU's buffer limit is below what ${model.label} stage ${span.stage + 1} needs.`);
      this.set({
        model: model.id,
        modelLabel: model.label,
        params: model.params,
        stage: span.stage,
        layers: [span.layerFrom, span.layerTo],
        stages: model.stageLayers.length,
        hasEmbed: span.hasEmbed,
        hasHead: span.hasHead,
        downloadBytes: model.stageDownloadBytes[span.stage] ?? 0,
        phase: "downloading",
        progress: 0,
      });
      this.abort = new AbortController();
      let lastReport = 0;
      const entries = await loadStageEntries(
        model,
        span,
        (b, t) => {
          const progress = t ? b / t : 0;
          this.set({ progress, downloadBytes: t || this.state.downloadBytes });
          if (Date.now() - lastReport > 2_000) {
            lastReport = Date.now();
            void this.post("/api/inference/shard", { state: "loading", progress }).catch(() => {});
          }
        },
        this.abort.signal,
      );
      if (!this.running) return;
      this.stage = await LlmStage.create(model, span, entries);
      if (!this.running) return;
      const ready = await this.post<{ relay: { url: string; exp: number } | null }>("/api/inference/shard", { state: "ready", progress: 1 });
      this.set({ phase: "connecting", progress: 1 });
      await this.serve(ready.relay);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!this.running) return;
      this.running = false;
      this.stage?.dispose();
      this.stage = null;
      this.set({ phase: "error", error: msg, connected: false });
      void this.post("/api/inference/shard", { state: "failed", error: msg }).catch(() => {});
    }
  }

  /** Keep a relay connection up for as long as the node runs; reconnect with backoff and a fresh ticket. */
  private async serve(first: { url: string; exp: number } | null) {
    let ticket = first;
    let failures = 0;
    while (this.running && this.stage) {
      if (!ticket || ticket.exp - Date.now() < 60_000) {
        try {
          ticket = (await this.post<{ relay: { url: string; exp: number } | null }>("/api/inference/ticket", {})).relay;
        } catch (e) {
          const msg = e instanceof Error ? e.message : "error";
          if (msg === "banned") return this.stop("error");
          ticket = null;
        }
      }
      if (!ticket) {
        // No relay (not configured server-side) or no token yet: the stage is loaded, wait and retry.
        this.set({ phase: "ready", connected: false });
        await sleep(10_000);
        continue;
      }
      const t0 = Date.now();
      const reason = await this.connection(ticket.url);
      if (!this.running) return;
      // A connection that lasted a while resets the backoff; "replaced" means another tab of this node took over.
      failures = Date.now() - t0 > 60_000 ? 0 : failures + 1;
      if (reason === "replaced") return this.stop("off");
      this.set({ connected: false, phase: "connecting" });
      await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)) + Math.random() * 1_000);
    }
  }

  /** One WebSocket lifetime. Resolves with the close reason when it ends. */
  private connection(url: string): Promise<string> {
    return new Promise<string>((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        resolve(e instanceof Error ? e.message : "connect_error");
        return;
      }
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let ping: ReturnType<typeof setInterval> | null = null;
      const finish = (reason: string) => {
        if (ping) clearInterval(ping);
        if (this.ws === ws) this.ws = null;
        resolve(reason);
      };
      ws.onopen = () => {
        this.set({ phase: "ready", connected: true, error: null });
        ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame({ t: "ping" }));
          const n = this.stage?.sweep(SESSION_IDLE_MS) ?? 0;
          if (n) this.set({ sessions: this.stage?.sessionCount ?? 0 });
        }, PING_MS);
      };
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        let frame;
        try {
          frame = decodeFrame<NodeInbound>(ev.data);
        } catch {
          return;
        }
        const h = frame.header;
        if (h.t === "hop") this.queue = this.queue.then(() => this.hop(ws, h, frame.payload)).catch(() => {});
        else if (h.t === "drop") {
          this.stage?.dropSession(h.session);
          this.set({ sessions: this.stage?.sessionCount ?? 0 });
        }
      };
      ws.onerror = () => {};
      ws.onclose = (ev) => finish(ev.reason || `closed_${ev.code}`);
    });
  }

  private async hop(ws: WebSocket, h: Extract<NodeInbound, { t: "hop" }>, payload: Uint8Array) {
    const stage = this.stage;
    if (!stage) return;
    const send = (msg: ResultMsg, body?: Uint8Array) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(msg, body));
    };
    try {
      const input = h.kind === "tokens" ? { tokens: new Uint32Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)) } : { hidden: unpackF16(payload) };
      const out = await stage.forward(h.session, input, h.seq, h.positions, h.cacheLen);
      let body: Uint8Array;
      if (out.logits) {
        const vocab = stage.cfg.vocab;
        const cols = [];
        for (let i = 0; i < headColumns(h.seq); i++) cols.push(topKOf(out.logits.subarray(i * vocab, (i + 1) * vocab)));
        body = packTopK(cols);
      } else if (out.hidden) body = packF16(out.hidden);
      else throw new Error("stage produced no output");
      send({ t: "result", hop: h.hop, ok: true, gpuMs: out.gpuMs, cacheLen: out.cacheLen }, body);
      const s = this.state;
      this.set({ hops: s.hops + 1, tokens: s.tokens + h.seq, gpuMs: s.gpuMs + out.gpuMs, lastHopAt: Date.now(), sessions: stage.sessionCount });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A cache mismatch means this node missed an earlier hop of the session; its cache is stale.
      if (msg.startsWith("cache_mismatch") || msg === "context_full") stage.dropSession(h.session);
      send({ t: "result", hop: h.hop, ok: false, gpuMs: 0, cacheLen: 0, error: msg.slice(0, 200) });
    }
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    const token = this.token();
    if (!token) throw new Error("unauthorized");
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : `http_${r.status}`);
    return j as T;
  }
}

const g = globalThis as typeof globalThis & { __brainInference?: InferenceWorker };
export const inferenceWorker = (g.__brainInference ??= new InferenceWorker());

export function useInference(): InferenceState {
  return useSyncExternalStore(inferenceWorker.subscribe, inferenceWorker.getSnapshot, inferenceWorker.getServerSnapshot);
}
