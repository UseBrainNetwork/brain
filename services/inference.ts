import type { ComputeJob } from "@/domain/types";
import { DEFAULT_NETWORK_MODEL, NETWORK_MODELS, hubUrl, stagePlan, stageUnits, type NetworkModel, type StageSpan } from "@/inference/config";
import { decodeF32, encodeF32 } from "@/inference/codec";
import { embed, finalLogits, mulberry32, relativeRms, sampleTopK, topK } from "@/inference/llama";
import { fetchHeader, fetchTensors } from "@/inference/safetensors";
import { StreamDecoder, Tokenizer, chatPrompt, type ChatTurn, type TokenizerJson } from "@/inference/tokenizer";
import { networkConfig } from "@/lib/config";
import { eventBus } from "./eventBus";
import { NodeError, publicJob } from "./nodes";
import { updateReputation } from "./reputation";
import { getStore, type StoredJob, type StoredNode } from "./store";

/**
 * Distributed LLM inference on the browser network.
 *
 * A model is split into pipeline stages of consecutive transformer layers. Contributor nodes load
 * one stage each (weights by range request from the Hugging Face CDN) and hold a per-session KV
 * cache. The gateway embeds the prompt, sends the hidden state through stage 0..S-1 as "hops",
 * applies the final norm and output projection itself, samples, and repeats per token.
 *
 * Verification: every hop is sent to two nodes holding the same stage when two are available. Their
 * outputs must agree within REPLICA_TOLERANCE (relative RMS). Only nodes whose hops were all
 * replica-checked and agreed get verified compute units; a stage served by a single node is
 * reported as unverified and earns nothing. Nothing a node reports (timing, success) is trusted.
 *
 * Honest limits: SmolLM2-135M quality, roughly one token per second (each token crosses S nodes over
 * HTTP), one session per request. Reported on every receipt as such.
 */

export const REPLICA_TOLERANCE = 1e-3;
const PREFILL_DEADLINE_MS = 20_000;
const DECODE_DEADLINE_MS = 8_000;
const HOP_POLL_MS = 120;
const ACTIVE_WINDOW_MS = 20_000;
const MAX_PROMPT_TOKENS = 512;
const MAX_CONCURRENT_SESSIONS = 4;
/** Wall-clock budget per session; generation stops with finish_reason "length" rather than hitting the function limit. */
const SESSION_BUDGET_MS = 240_000;
const TOP_K = 64;

/* ------------------------------------------------------------------ records */

export interface ShardRecord {
  nodeId: string;
  model: string;
  stage: number;
  layerFrom: number;
  layerTo: number;
  state: "loading" | "ready" | "failed";
  /** 0..1 while loading. */
  progress: number;
  updatedAt: number;
  readyAt?: number;
  error?: string;
}

export interface Hop {
  id: string;
  sessionId: string;
  model: string;
  stage: number;
  nodeId: string;
  /** 0 = prefill, then one per generated token. */
  step: number;
  seq: number;
  positions: number[];
  /** Cache length the node must have before applying this hop (ordering guard). */
  cacheLen: number;
  /** base64 f32 [seq, hidden]. Stripped after the session settles. */
  input?: string;
  status: "assigned" | "done" | "failed";
  issuedAt: number;
  deadline: number;
  output?: string;
  gpuMs?: number;
  doneAt?: number;
  error?: string;
}

export interface SessionNode {
  nodeId: string;
  stage: number;
  hops: number;
  tokens: number;
  /** Hops compared against a sibling. */
  checked: number;
  mismatches: number;
  gpuMs: number;
  dropped?: string;
}

export interface InferenceSession {
  id: string;
  model: string;
  status: "running" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  promptTokens: number;
  outputTokens: number;
  stages: { stage: number; layerFrom: number; layerTo: number; nodes: string[] }[];
  nodes: Record<string, SessionNode>;
  firstTokenMs?: number;
  totalMs?: number;
  finishReason?: "stop" | "length" | "error";
  error?: string;
  provenance: "live";
}

export interface NetworkRunSummary {
  sessionId: string;
  model: string;
  modelLabel: string;
  promptTokens: number;
  outputTokens: number;
  firstTokenMs: number | null;
  totalMs: number;
  tokPerSec: number | null;
  stages: { stage: number; layers: string; nodes: { id: string; hops: number; gpuMs: number; verified: boolean | null; dropped?: string }[] }[];
  /** "replica-tolerance" when every stage had two agreeing nodes for every hop; otherwise "unverified". */
  verification: "replica-tolerance" | "unverified";
  verified: boolean;
  units: { total: number; verified: number };
  finishReason: "stop" | "length" | "error";
  error?: string;
}

export type NetworkChatEvent = { type: "token"; text: string; token: number } | { type: "status"; detail: string };

/* ------------------------------------------------------------------ gateway weights */

interface GatewayWeights {
  tokenizer: Tokenizer;
  embed: Float32Array;
  norm: Float32Array;
  bytes: number;
  loadedAt: number;
}

const g = globalThis as typeof globalThis & { __brainGateway?: Map<string, Promise<GatewayWeights>> };

/** Tokenizer, embedding matrix and final norm for the gateway side. Fetched once per instance. */
export function gatewayWeights(model: NetworkModel = DEFAULT_NETWORK_MODEL): Promise<GatewayWeights> {
  g.__brainGateway ??= new Map();
  let p = g.__brainGateway.get(model.id);
  if (!p) {
    p = (async () => {
      const t0 = Date.now();
      const [tokJson, header] = await Promise.all([
        fetch(hubUrl(model, model.tokenizerFile)).then((r) => {
          if (!r.ok) throw new Error(`tokenizer ${r.status}`);
          return r.json() as Promise<TokenizerJson>;
        }),
        fetchHeader(hubUrl(model, model.weightsFile)),
      ]);
      const tensors = await fetchTensors(hubUrl(model, model.weightsFile), header, ["model.embed_tokens.weight", "model.norm.weight"]);
      console.log(`[inference] gateway weights for ${model.id}: ${(tensors.bytesFetched / 1e6).toFixed(1)} MB in ${Date.now() - t0} ms`);
      return { tokenizer: new Tokenizer(tokJson), embed: tensors.get("model.embed_tokens.weight"), norm: tensors.get("model.norm.weight"), bytes: tensors.bytesFetched, loadedAt: Date.now() };
    })();
    g.__brainGateway.set(model.id, p);
    p.catch(() => g.__brainGateway?.delete(model.id));
  }
  return p;
}

/* ------------------------------------------------------------------ shards */

const isLive = (n: StoredNode, now: number) => (n.status === "idle" || n.status === "computing") && now - n.lastHeartbeatAt <= networkConfig.nodes.offlineAfterMs;

export async function listLiveShards(model: NetworkModel, now = Date.now()): Promise<{ shard: ShardRecord; node: StoredNode }[]> {
  const store = getStore();
  const all = await store.listDocs<ShardRecord>("shard", { limit: 500 });
  const mine = all.filter((s) => s.model === model.id && now - s.updatedAt < 6 * 60 * 60_000);
  if (!mine.length) return [];
  const nodes = await store.getNodes(mine.map((s) => s.nodeId));
  const out: { shard: ShardRecord; node: StoredNode }[] = [];
  for (const shard of mine) {
    const node = nodes.get(shard.nodeId);
    if (node && isLive(node, now)) out.push({ shard, node });
  }
  return out;
}

export interface StageCapacity {
  stage: number;
  layerFrom: number;
  layerTo: number;
  ready: number;
  loading: number;
}

export interface InferenceCapacity {
  model: string;
  modelLabel: string;
  license: string;
  stages: StageCapacity[];
  /** Every stage has at least one ready node. */
  available: boolean;
  /** Every stage has at least two ready nodes, so every hop can be replica-checked. */
  verifiable: boolean;
  readyNodes: number;
  provenance: "live";
}

export async function inferenceCapacity(model: NetworkModel = DEFAULT_NETWORK_MODEL): Promise<InferenceCapacity> {
  const live = await listLiveShards(model);
  const stages = stagePlan(model).map((s) => ({
    ...s,
    ready: live.filter((x) => x.shard.stage === s.stage && x.shard.state === "ready").length,
    loading: live.filter((x) => x.shard.stage === s.stage && x.shard.state === "loading").length,
  }));
  return {
    model: model.id,
    modelLabel: model.label,
    license: model.license,
    stages,
    available: stages.every((s) => s.ready >= 1),
    verifiable: stages.every((s) => s.ready >= 2),
    readyNodes: stages.reduce((a, s) => a + s.ready, 0),
    provenance: "live",
  };
}

/**
 * Which stage a node should load: keep its current assignment if it still exists, otherwise the
 * stage with the fewest live holders (ready or loading), lowest index first.
 */
export function assignShard(node: StoredNode, model: NetworkModel = DEFAULT_NETWORK_MODEL): Promise<{ model: NetworkModel; span: StageSpan; record: ShardRecord }> {
  // Several nodes come online together (a fleet reload); without the lock they would all see the
  // same empty counts and pick the same stage.
  return getStore().withLock("inference:assign", () => assignShardUnlocked(node, model));
}

async function assignShardUnlocked(node: StoredNode, model: NetworkModel): Promise<{ model: NetworkModel; span: StageSpan; record: ShardRecord }> {
  const store = getStore();
  const now = Date.now();
  const plan = stagePlan(model);
  const existing = await store.getDoc<ShardRecord>("shard", node.id);
  let span: StageSpan | undefined;
  if (existing && existing.model === model.id && existing.state !== "failed") span = plan.find((s) => s.stage === existing.stage);
  if (!span) {
    const live = await listLiveShards(model, now);
    const counts = plan.map((s) => live.filter((x) => x.shard.stage === s.stage && x.shard.nodeId !== node.id).length);
    let best = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] < counts[best]) best = i;
    span = plan[best];
  }
  const record: ShardRecord = { nodeId: node.id, model: model.id, stage: span.stage, layerFrom: span.layerFrom, layerTo: span.layerTo, state: existing?.state === "ready" && existing.stage === span.stage ? "ready" : "loading", progress: existing?.stage === span.stage ? (existing.progress ?? 0) : 0, updatedAt: now, readyAt: existing?.stage === span.stage ? existing.readyAt : undefined };
  await store.putDoc("shard", node.id, record, { at: now, key: `${model.id}:${span.stage}` });
  return { model, span, record };
}

export async function reportShard(node: StoredNode, patch: { state: ShardRecord["state"]; progress?: number; error?: string }): Promise<ShardRecord> {
  const store = getStore();
  const existing = await store.getDoc<ShardRecord>("shard", node.id);
  if (!existing) throw new NodeError("no_shard", 404);
  const now = Date.now();
  const next: ShardRecord = {
    ...existing,
    state: patch.state,
    progress: patch.state === "ready" ? 1 : Math.max(0, Math.min(1, patch.progress ?? existing.progress)),
    updatedAt: now,
    readyAt: patch.state === "ready" ? (existing.readyAt ?? now) : existing.readyAt,
    error: patch.state === "failed" ? String(patch.error ?? "failed").slice(0, 200) : undefined,
  };
  await store.putDoc("shard", node.id, next, { at: now, key: `${next.model}:${next.stage}` });
  return next;
}

/* ------------------------------------------------------------------ hops: node side */

export interface HopPayload {
  id: string;
  sessionId: string;
  model: string;
  stage: number;
  step: number;
  seq: number;
  positions: number[];
  cacheLen: number;
  input: string;
  deadline: number;
}

/**
 * Every ready node asks "is a session running?" on every poll. With dozens of nodes that was the
 * single biggest source of Postgres traffic, so the answer is cached per instance for 3 s (a new
 * session is noticed within one extra poll) and a node's own shard record for 15 s.
 */
const ac = globalThis as typeof globalThis & { __brainActive?: { at: number; value: Promise<boolean> }; __brainShards?: Map<string, { at: number; value: Promise<ShardRecord | null> }> };
async function isActive(now: number): Promise<boolean> {
  if (ac.__brainActive && now - ac.__brainActive.at < 3_000) return ac.__brainActive.value;
  const value = getStore()
    .getDoc<{ at: number }>("meta", "inference-active")
    .then((a) => Boolean(a && Date.now() - a.at < ACTIVE_WINDOW_MS));
  ac.__brainActive = { at: now, value };
  value.catch(() => (ac.__brainActive = undefined));
  return value;
}
async function cachedShard(nodeId: string, now: number): Promise<ShardRecord | null> {
  ac.__brainShards ??= new Map();
  const hit = ac.__brainShards.get(nodeId);
  if (hit && now - hit.at < 15_000) return hit.value;
  const value = getStore().getDoc<ShardRecord>("shard", nodeId);
  ac.__brainShards.set(nodeId, { at: now, value });
  value.catch(() => ac.__brainShards?.delete(nodeId));
  if (ac.__brainShards.size > 2_000) for (const [k, v] of ac.__brainShards) if (now - v.at > 15_000) ac.__brainShards.delete(k);
  return value;
}

async function markActive(): Promise<void> {
  const now = Date.now();
  await getStore().putDoc("meta", "inference-active", { at: now }, { at: now });
}

/**
 * Next hop for a node. Long-polls up to `waitMs` only while a session is active somewhere; when the
 * network is idle it answers immediately with a retry hint so idle nodes cost the store nothing.
 */
export async function nextHop(node: StoredNode, waitMs: number): Promise<{ hop: HopPayload | null; retryMs: number; active: boolean }> {
  const store = getStore();
  const shard = await cachedShard(node.id, Date.now());
  if (!shard || shard.state !== "ready") return { hop: null, retryMs: 5_000, active: false };
  const until = Date.now() + Math.max(0, Math.min(waitMs, 8_000));
  let active = await isActive(Date.now());
  let lastActiveCheck = Date.now();
  for (;;) {
    const now = Date.now();
    const hops = await store.listDocs<Hop>("hop", { key: node.id, limit: 8, from: now - 60_000 });
    const open = hops.filter((h) => h.status === "assigned" && h.deadline > now && h.input).sort((a, b) => a.step - b.step);
    const h = open[0];
    if (h) return { hop: { id: h.id, sessionId: h.sessionId, model: h.model, stage: h.stage, step: h.step, seq: h.seq, positions: h.positions, cacheLen: h.cacheLen, input: h.input!, deadline: h.deadline }, retryMs: 0, active: true };
    // Idle network: one look for hops, then send the node away for a few seconds instead of having
    // every node come back every second and a half.
    if (!active || now >= until) return { hop: null, retryMs: active ? 250 : 4_000, active };
    if (now - lastActiveCheck > 3_000) {
      active = await isActive(now);
      lastActiveCheck = now;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function submitHop(node: StoredNode, hopId: string, body: { output?: string; gpuMs?: number; error?: string }): Promise<{ ok: boolean }> {
  const store = getStore();
  const hop = await store.getDoc<Hop>("hop", hopId);
  if (!hop || hop.nodeId !== node.id) throw new NodeError("unknown_hop", 404);
  if (hop.status !== "assigned") throw new NodeError("hop_closed", 409);
  const now = Date.now();
  const model = NETWORK_MODELS[hop.model];
  let next: Hop;
  if (body.error || !body.output) {
    next = { ...hop, status: "failed", error: String(body.error ?? "no output").slice(0, 200), doneAt: now };
  } else {
    const expectedBytes = hop.seq * (model?.config.hidden ?? 0) * 4;
    const actualBytes = Math.floor((body.output.length * 3) / 4) - (body.output.endsWith("==") ? 2 : body.output.endsWith("=") ? 1 : 0);
    if (!model || actualBytes !== expectedBytes) next = { ...hop, status: "failed", error: `malformed output (${actualBytes} bytes, expected ${expectedBytes})`, doneAt: now };
    else next = { ...hop, status: now > hop.deadline ? "failed" : "done", output: body.output, gpuMs: Math.max(0, Number(body.gpuMs) || 0), doneAt: now, error: now > hop.deadline ? "deadline" : undefined };
  }
  await store.putDoc("hop", hop.id, next, { at: hop.issuedAt, key: hop.nodeId });
  return { ok: next.status === "done" };
}

/* ------------------------------------------------------------------ session orchestration */

export interface NetworkChatInput {
  messages: ChatTurn[];
  maxTokens: number;
  temperature: number;
  topP: number;
  seed?: number;
  model?: NetworkModel;
}

class StageRun {
  /** Nodes still in the pipeline for this stage, in preference order. */
  nodes: string[];
  constructor(
    readonly span: StageSpan,
    nodes: string[],
  ) {
    this.nodes = nodes;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one chat completion on the network. Emits tokens as they are sampled and returns the summary
 * once the session is terminal. Throws `NodeError("no_capacity")` before any work if a stage has
 * no ready node.
 */
export async function runNetworkChat(input: NetworkChatInput, emit: (e: NetworkChatEvent) => void, signal?: AbortSignal): Promise<NetworkRunSummary> {
  const model = input.model ?? DEFAULT_NETWORK_MODEL;
  const store = getStore();
  const t0 = Date.now();

  const running = (await store.listDocs<InferenceSession>("isession", { limit: 20, from: t0 - 5 * 60_000 })).filter((s) => s.status === "running" && t0 - s.updatedAt < 30_000);
  if (running.length >= MAX_CONCURRENT_SESSIONS) throw new NodeError("busy", 503);

  const live = await listLiveShards(model, t0);
  const plan = stagePlan(model);
  const stages = plan.map((span) => {
    const holders = live
      .filter((x) => x.shard.stage === span.stage && x.shard.state === "ready")
      .sort((a, b) => b.node.reputation - a.node.reputation || b.node.computeScore - a.node.computeScore)
      .slice(0, 2)
      .map((x) => x.node.id);
    return new StageRun(span, holders);
  });
  const missing = stages.filter((s) => s.nodes.length === 0).map((s) => s.span.stage);
  if (missing.length) throw new NodeError(`no_capacity:stage ${missing.join(",")} has no ready node`, 503);

  emit({ type: "status", detail: `pipeline: ${stages.map((s) => `${s.nodes.length} node${s.nodes.length === 1 ? "" : "s"}`).join(" → ")}` });
  const tGw = Date.now();
  const warm = g.__brainGateway?.has(model.id);
  if (!warm) emit({ type: "status", detail: "loading gateway weights (embedding + output projection) on this server, first request only" });
  const gw = await gatewayWeights(model);
  const gatewayMs = Date.now() - tGw;
  const cfg = model.config;
  const promptText = chatPrompt(input.messages);
  let promptIds = gw.tokenizer.encode(promptText);
  if (promptIds.length > MAX_PROMPT_TOKENS) {
    // Keep the system turn head and the most recent tokens; the template tail (assistant header) must survive.
    promptIds = promptIds.slice(promptIds.length - MAX_PROMPT_TOKENS);
  }
  const maxNew = Math.max(1, Math.min(input.maxTokens, model.maxContext - promptIds.length - 1));

  const sessionId = `is-${t0.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const session: InferenceSession = {
    id: sessionId,
    model: model.id,
    status: "running",
    createdAt: t0,
    updatedAt: t0,
    promptTokens: promptIds.length,
    outputTokens: 0,
    stages: stages.map((s) => ({ stage: s.span.stage, layerFrom: s.span.layerFrom, layerTo: s.span.layerTo, nodes: [...s.nodes] })),
    nodes: {},
    provenance: "live",
  };
  for (const s of stages) for (const n of s.nodes) session.nodes[n] = { nodeId: n, stage: s.span.stage, hops: 0, tokens: 0, checked: 0, mismatches: 0, gpuMs: 0 };
  await store.putDoc("isession", sessionId, session, { at: t0, key: model.id });
  await markActive();

  const pendingPairs: { ids: [string, string]; credited: Set<string> }[] = [];
  const hopIds: { id: string; nodeId: string; issuedAt: number }[] = [];
  let hopSeq = 0;

  const issue = async (stage: StageRun, step: number, hidden: Float32Array, seq: number, positions: number[], cacheLen: number): Promise<Hop[]> => {
    const now = Date.now();
    const deadline = now + (step === 0 ? PREFILL_DEADLINE_MS + seq * 20 : DECODE_DEADLINE_MS);
    const input = encodeF32(hidden);
    const hops: Hop[] = stage.nodes.map((nodeId) => ({
      id: `${sessionId}-${stage.span.stage}-${step}-${(hopSeq++).toString(36)}`,
      sessionId,
      model: model.id,
      stage: stage.span.stage,
      nodeId,
      step,
      seq,
      positions,
      cacheLen,
      input,
      status: "assigned",
      issuedAt: now,
      deadline,
    }));
    await Promise.all(hops.map((h) => store.putDoc("hop", h.id, h, { at: now, key: h.nodeId })));
    for (const h of hops) hopIds.push({ id: h.id, nodeId: h.nodeId, issuedAt: now });
    return hops;
  };

  /** Wait for the first successful result among the hops; drop nodes that fail. */
  const collect = async (stage: StageRun, hops: Hop[]): Promise<Float32Array> => {
    const states = new Map(hops.map((h) => [h.id, h]));
    const deadline = Math.max(...hops.map((h) => h.deadline));
    for (;;) {
      if (signal?.aborted) throw new NodeError("aborted", 499);
      const now = Date.now();
      const fresh = await Promise.all(hops.map((h) => store.getDoc<Hop>("hop", h.id)));
      fresh.forEach((h) => h && states.set(h.id, h));
      const done = [...states.values()].filter((h) => h.status === "done" && h.output);
      const failed = [...states.values()].filter((h) => h.status === "failed" || (h.status === "assigned" && h.deadline < now));
      for (const f of failed) {
        const sn = session.nodes[f.nodeId];
        if (sn && !sn.dropped) sn.dropped = f.error ?? "deadline";
        stage.nodes = stage.nodes.filter((n) => n !== f.nodeId);
      }
      if (done.length) {
        for (const d of done) credit(d);
        if (done.length === 2) compare(done[0], done[1]);
        else if (hops.length === 2 && failed.length === 0) pendingPairs.push({ ids: [hops[0].id, hops[1].id], credited: new Set(done.map((d) => d.id)) });
        return decodeF32(done[0].output!);
      }
      if (stage.nodes.length === 0 || now > deadline) throw new NodeError(`stage ${stage.span.stage} lost: ${failed.map((f) => f.error ?? "deadline").join("; ") || "no result"}`, 503);
      await sleep(HOP_POLL_MS);
    }
  };

  const credit = (h: Hop) => {
    const sn = session.nodes[h.nodeId]!;
    sn.hops++;
    sn.tokens += h.seq;
    sn.gpuMs += h.gpuMs ?? 0;
  };

  const compare = (a: Hop, b: Hop) => {
    const rms = relativeRms(decodeF32(a.output!), decodeF32(b.output!));
    const ok = rms <= REPLICA_TOLERANCE;
    for (const h of [a, b]) {
      const sn = session.nodes[h.nodeId]!;
      sn.checked++;
      if (!ok) sn.mismatches++;
    }
  };

  /** Resolve pairs whose sibling finished after we moved on. */
  const settlePairs = async (waitMs: number) => {
    const until = Date.now() + waitMs;
    while (pendingPairs.length) {
      const next: typeof pendingPairs = [];
      for (const p of pendingPairs) {
        const [a, b] = await Promise.all([store.getDoc<Hop>("hop", p.ids[0]), store.getDoc<Hop>("hop", p.ids[1])]);
        if (a?.status === "done" && b?.status === "done" && a.output && b.output) {
          // The late sibling's work counts now that it is in; then the pair is compared.
          for (const h of [a, b]) if (!p.credited.has(h.id)) credit(h);
          compare(a, b);
        } else if (a?.status === "failed" || b?.status === "failed" || Date.now() > until) {
          // Unresolvable: the hop stays unchecked for the node that did answer.
        } else next.push(p);
      }
      pendingPairs.length = 0;
      pendingPairs.push(...next);
      if (pendingPairs.length) await sleep(150);
    }
  };

  const rnd = mulberry32(input.seed ?? (t0 >>> 0));
  const sampling = { temperature: Math.max(0, Math.min(2, input.temperature)), topP: Math.max(0.05, Math.min(1, input.topP)), seed: input.seed ?? 0 };
  const decoder = new StreamDecoder(gw.tokenizer);
  const out: number[] = [];
  let finishReason: NetworkRunSummary["finishReason"] = "length";
  let firstTokenMs: number | null = null;
  let error: string | undefined;

  const touch = async () => {
    session.updatedAt = Date.now();
    session.outputTokens = out.length;
    await Promise.all([store.putDoc("isession", sessionId, session, { at: t0, key: model.id }), markActive()]);
  };

  try {
    // Prefill
    let hidden = embed(gw.embed, cfg.hidden, promptIds);
    const positions = promptIds.map((_, i) => i);
    const stageMs: number[] = [];
    for (const stage of stages) {
      const ts = Date.now();
      const hops = await issue(stage, 0, hidden, promptIds.length, positions, 0);
      hidden = await collect(stage, hops);
      stageMs.push(Date.now() - ts);
    }
    console.log(`[inference] ${sessionId} prefill ${promptIds.length} tokens: gateway ${gatewayMs} ms, stages ${stageMs.join("/")} ms`);
    let last = hidden.subarray((promptIds.length - 1) * cfg.hidden);
    await touch();

    for (let step = 1; step <= maxNew; step++) {
      if (signal?.aborted) throw new NodeError("aborted", 499);
      if (Date.now() - t0 > SESSION_BUDGET_MS) break;
      const logits = finalLogits(cfg, gw.norm, gw.embed, last);
      const tok = sampleTopK(topK(logits, TOP_K), sampling, rnd);
      if (cfg.eos.includes(tok)) {
        finishReason = "stop";
        break;
      }
      out.push(tok);
      if (firstTokenMs == null) firstTokenMs = Date.now() - t0;
      const text = decoder.push(tok);
      if (text) emit({ type: "token", text, token: tok });
      if (step === maxNew) break;
      let h = embed(gw.embed, cfg.hidden, [tok]);
      const pos = promptIds.length + step - 1;
      for (const stage of stages) {
        const hops = await issue(stage, step, h, 1, [pos], pos);
        h = await collect(stage, hops);
      }
      last = h;
      if (step % 4 === 0) await touch();
    }
    const tail = decoder.flush();
    if (tail) emit({ type: "token", text: tail, token: -1 });
  } catch (e) {
    finishReason = "error";
    error = e instanceof Error ? e.message : String(e);
    console.warn(`[inference] ${sessionId} failed after ${out.length} tokens: ${error}`);
  }

  await settlePairs(4_000);
  const totalMs = Date.now() - t0;
  session.status = finishReason === "error" ? "failed" : "completed";
  session.finishReason = finishReason;
  session.error = error;
  session.firstTokenMs = firstTokenMs ?? undefined;
  session.totalMs = totalMs;
  session.outputTokens = out.length;
  session.updatedAt = Date.now();
  await store.putDoc("isession", sessionId, session, { at: t0, key: model.id });

  const summary = await settleSession(model, session);
  // Hidden states are not kept: strip the payloads once the session is settled.
  void Promise.all(
    hopIds.map(async (h) => {
      const doc = await store.getDoc<Hop>("hop", h.id);
      if (doc) await store.putDoc("hop", h.id, { ...doc, input: undefined, output: undefined }, { at: h.issuedAt, key: h.nodeId });
    }),
  ).catch(() => {});
  return summary;
}

/* ------------------------------------------------------------------ settlement */

/**
 * Turn a terminal session into job-ledger rows, one per participating node. Verified only when the
 * node served at least one hop, every one of its hops was replica-checked and none disagreed.
 * Unverified work is recorded as such ("no-replica") and earns nothing; it does not count against
 * the node's pass rate either, because it is the network's shortfall, not the node's.
 */
export async function settleSession(model: NetworkModel, session: InferenceSession): Promise<NetworkRunSummary> {
  const store = getStore();
  const now = Date.now();
  const cfg = model.config;
  const stageOf = new Map(session.stages.map((s) => [s.stage, s]));
  let totalUnits = 0;
  let verifiedUnits = 0;
  const verdicts = new Map<string, boolean | null>();

  for (const sn of Object.values(session.nodes)) {
    if (sn.hops === 0) {
      verdicts.set(sn.nodeId, null);
      continue;
    }
    const st = stageOf.get(sn.stage)!;
    const layers = st.layerTo - st.layerFrom;
    const units = stageUnits(cfg, layers, sn.tokens);
    const disputed = sn.mismatches > 0;
    const fullyChecked = sn.checked >= sn.hops;
    const verified = !disputed && fullyChecked;
    const failReason = disputed ? "replica-dispute" : fullyChecked ? undefined : "no-replica";
    verdicts.set(sn.nodeId, disputed ? false : fullyChecked ? true : null);
    totalUnits += units;
    if (verified) verifiedUnits += units;

    const id = String(await store.nextJobNumber());
    const job: StoredJob = {
      id,
      model: `brain/${model.id}`,
      kind: "inference",
      status: disputed ? "failed" : "completed",
      nodeIds: [sn.nodeId],
      workUnits: sn.hops,
      computeUnits: units,
      latencyMs: session.totalMs,
      submittedAt: session.createdAt,
      lifecycle: [
        { stage: "submitted", at: session.createdAt, detail: `network inference session ${session.id}, stage ${sn.stage} (layers ${st.layerFrom}–${st.layerTo - 1})` },
        { stage: "executing", at: session.createdAt, detail: `${sn.hops} hops · ${sn.tokens} tokens · client GPU ${Math.round(sn.gpuMs)} ms (reported)` },
        { stage: "verifying", at: now, detail: `replica-tolerance: ${sn.checked}/${sn.hops} hops checked, ${sn.mismatches} disagreements` },
        verified ? { stage: "completed", at: now, detail: `+${units} units` } : { stage: "failed", at: now, detail: failReason },
      ],
      provenance: "live",
      spec: { kernel: "llm_stage", model: model.id, layerFrom: st.layerFrom, layerTo: st.layerTo, tokens: sn.tokens },
      assignedTo: sn.nodeId,
      issuedAt: session.createdAt,
      deadline: now,
      canary: false,
      sampleIndices: [],
      verified,
      failReason,
    };
    await store.saveJob(job);
    const node = await store.getNode(sn.nodeId);
    if (node) {
      let updated = node;
      if (verified) updated = { ...updateReputation(node, true), verifiedComputeUnits: node.verifiedComputeUnits + units };
      // Disputes are not attributed: two nodes disagreed and we cannot tell which is wrong.
      if (updated !== node) await store.saveNode(updated);
    }
    const pub: ComputeJob = publicJob(job);
    eventBus.publish({ type: "job.completed", at: now, job: pub });
    if (verified) eventBus.publish({ type: "node.verified", at: now, nodeId: sn.nodeId, units, jobId: id });
  }

  const stages = session.stages.map((s) => ({
    stage: s.stage,
    layers: `${s.layerFrom}–${s.layerTo - 1}`,
    nodes: s.nodes.map((id) => {
      const sn = session.nodes[id]!;
      return { id, hops: sn.hops, gpuMs: Math.round(sn.gpuMs), verified: verdicts.get(id) ?? null, dropped: sn.dropped };
    }),
  }));
  const allVerified = session.status === "completed" && stages.every((s) => s.nodes.some((n) => n.verified === true)) && [...verdicts.values()].every((v) => v !== false);
  const tokPerSec = session.outputTokens > 1 && session.totalMs && session.firstTokenMs != null ? +(((session.outputTokens - 1) * 1000) / Math.max(1, session.totalMs - session.firstTokenMs)).toFixed(2) : null;
  return {
    sessionId: session.id,
    model: model.id,
    modelLabel: model.label,
    promptTokens: session.promptTokens,
    outputTokens: session.outputTokens,
    firstTokenMs: session.firstTokenMs ?? null,
    totalMs: session.totalMs ?? 0,
    tokPerSec,
    stages,
    verification: allVerified ? "replica-tolerance" : "unverified",
    verified: allVerified,
    units: { total: totalUnits, verified: verifiedUnits },
    finishReason: session.finishReason ?? "error",
    error: session.error,
  };
}

/* ------------------------------------------------------------------ public views */

export async function recentSessions(limit = 20): Promise<InferenceSession[]> {
  const s = await getStore().listDocs<InferenceSession>("isession", { limit });
  return s.map((x) => ({ ...x }));
}

export async function inferenceStatus() {
  const [capacity, sessions] = await Promise.all([inferenceCapacity(), recentSessions(50)]);
  const completed = sessions.filter((s) => s.status === "completed");
  const tokens = completed.reduce((a, s) => a + s.outputTokens, 0);
  const secs = completed.reduce((a, s) => a + Math.max(0, (s.totalMs ?? 0) - (s.firstTokenMs ?? 0)), 0) / 1000;
  return {
    capacity,
    sessions: { recent: sessions.length, completed: completed.length, failed: sessions.filter((s) => s.status === "failed").length, running: sessions.filter((s) => s.status === "running" && Date.now() - s.updatedAt < 30_000).length },
    outputTokens: tokens,
    /** Decode throughput across recent completed sessions; null until there is data. */
    tokPerSec: completed.length && secs > 0 ? +((tokens - completed.length) / secs).toFixed(2) : null,
    provenance: "live" as const,
  };
}
