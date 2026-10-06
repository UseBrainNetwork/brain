"use client";

import { useSyncExternalStore } from "react";
import { NETWORK_MODELS, type NetworkModel, type StageSpan } from "@/inference/config";
import { decodeF32, encodeF32 } from "@/inference/codec";
import { loadStageTensors, stageDownloadBytes } from "@/inference/shardLoader";
import { LlmStage } from "@/webgpu/llm";

/**
 * The node's inference side: load the pipeline stage the server assigns, then serve hops (run the
 * stage's layers over a hidden state, keep the session's KV cache) for as long as the node is up.
 * Runs next to the verification-job loop in network/client/contributor.ts.
 */

export type InferencePhase = "off" | "assigning" | "downloading" | "ready" | "error";

export interface InferenceState {
  enabled: boolean;
  phase: InferencePhase;
  model: string | null;
  modelLabel: string | null;
  stage: number | null;
  layers: [number, number] | null;
  stages: number | null;
  /** 0..1 download progress. */
  progress: number;
  downloadBytes: number;
  hops: number;
  tokens: number;
  gpuMs: number;
  sessions: number;
  lastHopAt: number | null;
  /** Whether a session is active anywhere on the network (from the last poll). */
  networkActive: boolean;
  error: string | null;
}

const LS_KEY = "brain.inference.v1";
const MIN_BUFFER_BYTES = 256 * 1024 * 1024;
const SESSION_IDLE_MS = 120_000;

const initial: InferenceState = {
  enabled: false,
  phase: "off",
  model: null,
  modelLabel: null,
  stage: null,
  layers: null,
  stages: null,
  progress: 0,
  downloadBytes: 0,
  hops: 0,
  tokens: 0,
  gpuMs: 0,
  sessions: 0,
  lastHopAt: null,
  networkActive: false,
  error: null,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Default on for desktop-class browsers; phones opt in (a stage is a ~70 MB download). */
export function defaultEnabled(): boolean {
  if (typeof navigator === "undefined") return false;
  const stored = localStorage.getItem(LS_KEY);
  if (stored === "on") return true;
  if (stored === "off") return false;
  const uaMobile = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile;
  if (typeof uaMobile === "boolean") return !uaMobile;
  return !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

class InferenceWorker {
  private state: InferenceState = initial;
  private listeners = new Set<() => void>();
  private running = false;
  private stage: LlmStage | null = null;
  private abort: AbortController | null = null;
  private token: () => string | null = () => null;
  private maxBufferBytes = 0;

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
    this.stage?.dispose();
    this.stage = null;
    this.set({ phase: reason, progress: 0, sessions: 0, networkActive: false });
  }

  private async run() {
    try {
      this.set({ phase: "assigning", error: null });
      const a = await this.post<{ model: NetworkModel; span: StageSpan; state: string }>("/api/inference/assign", {});
      const model = NETWORK_MODELS[a.model.id] ?? a.model;
      const span = a.span;
      this.set({ model: model.id, modelLabel: model.label, stage: span.stage, layers: [span.layerFrom, span.layerTo], stages: model.stages, downloadBytes: stageDownloadBytes(model, span), phase: "downloading", progress: 0 });
      this.abort = new AbortController();
      let lastReport = 0;
      const tensors = await loadStageTensors(
        model,
        span,
        (b, t) => {
          const progress = t ? b / t : 0;
          this.set({ progress, downloadBytes: t });
          if (Date.now() - lastReport > 2_000) {
            lastReport = Date.now();
            void this.post("/api/inference/shard", { state: "loading", progress }).catch(() => {});
          }
        },
        this.abort.signal,
      );
      if (!this.running) return;
      this.stage = await LlmStage.create(model, span, tensors);
      await this.post("/api/inference/shard", { state: "ready", progress: 1 });
      this.set({ phase: "ready", progress: 1 });
      await this.loop();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!this.running) return;
      this.running = false;
      this.set({ phase: "error", error: msg });
      void this.post("/api/inference/shard", { state: "failed", error: msg }).catch(() => {});
    }
  }

  private async loop() {
    let failures = 0;
    while (this.running && this.stage) {
      try {
        const r = await this.post<{ hop: { id: string; sessionId: string; seq: number; positions: number[]; cacheLen: number; input: string; deadline: number } | null; retryMs: number; active: boolean }>(
          "/api/inference/next",
          { waitMs: 6_000 },
        );
        failures = 0;
        this.set({ networkActive: r.active });
        if (!r.hop) {
          this.stage.sweep(SESSION_IDLE_MS);
          this.set({ sessions: this.stage.sessionCount });
          await sleep(Math.max(100, Math.min(5_000, r.retryMs || 2_000)));
          continue;
        }
        const h = r.hop;
        if (Date.now() > h.deadline) continue;
        try {
          const hidden = decodeF32(h.input);
          const out = await this.stage.forward(h.sessionId, hidden, h.seq, h.positions, h.cacheLen);
          await this.post("/api/inference/result", { hopId: h.id, output: encodeF32(out.hidden), gpuMs: out.gpuMs });
          const s = this.state;
          this.set({ hops: s.hops + 1, tokens: s.tokens + h.seq, gpuMs: s.gpuMs + out.gpuMs, lastHopAt: Date.now(), sessions: this.stage.sessionCount });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // A cache mismatch means this node missed an earlier hop of the session; its cache is stale.
          if (msg.startsWith("cache_mismatch") || msg === "context_full") this.stage.dropSession(h.sessionId);
          await this.post("/api/inference/result", { hopId: h.id, error: msg }).catch(() => {});
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "error";
        if (msg === "unauthorized" || msg === "banned") {
          // The contributor engine handles re-registration; back off and retry with the new token.
          await sleep(4_000);
          if (msg === "banned") return this.stop("error");
          continue;
        }
        failures++;
        await sleep(Math.min(15_000, 1_000 * 2 ** Math.min(failures, 4)));
      }
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
