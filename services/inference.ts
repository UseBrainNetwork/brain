import type { ComputeJob } from "@/domain/types";
import { DEFAULT_NETWORK_MODEL, MODEL_LADDER, MODEL_PREFERENCE, NETWORK_MODELS, nodeFitsStage, stagePlan, stageUnits, tokenizerUrl, type NetworkModel, type StageSpan, isSingleTab } from "@/inference/config";
import { mulberry32, sampleTopK } from "@/inference/llama";
import { REPLICA_TOLERANCE, unpackTopK, type LapStage, type StageMsg } from "@/inference/protocol";
import { StreamDecoder, Tokenizer, chatPrompt, type ChatTurn, type TokenizerJson } from "@/inference/tokenizer";
import { networkConfig } from "@/lib/config";
import { eventBus } from "./eventBus";
import { NodeError, publicJob } from "./nodes";
import { RelaySession, relayConfigured, relayPresence } from "./relay";
import { updateReputation } from "./reputation";
import { getStore, type StoredJob, type StoredNode } from "./store";

/**
 * Distributed LLM inference on the browser network.
 *
 * A model is split into pipeline stages of consecutive transformer layers. Contributor nodes load
 * one stage each (weights by range request from the Hugging Face CDN) and hold a per-session KV
 * cache. Stage 0 also embeds token ids; the last stage applies the final norm and output projection
 * and returns top-k logits. The gateway holds no weights: it tokenizes, sends token ids through the
 * relay (relay/), samples from the returned top-k and settles rewards.
 *
 * Speed: hidden states hop node→node through a persistent WebSocket relay, and each lap can carry
 * several tokens (prompt-lookup drafts verified in one pass), so a token costs a fraction of a lap.
 *
 * Verification: every stage of every lap runs on two nodes when two hold it. Their outputs must
 * agree within REPLICA_TOLERANCE (relative RMS; for the head, over the shared top-k logits). Only
 * nodes whose hops were all replica-checked and agreed get verified compute units; a stage served
 * by a single node is reported as unverified and earns nothing. Nothing a node reports (timing,
 * success) is trusted. A disagreement stops the session and is reported as such.
 */

export { REPLICA_TOLERANCE };
const PREFILL_HOP_MS = 20_000;
const DECODE_HOP_MS = 8_000;
const MAX_PROMPT_TOKENS = 512;
const MAX_CONCURRENT_SESSIONS = 6;
/** Wall-clock budget per session; generation stops with finish_reason "length" rather than hitting the function limit. */
const SESSION_BUDGET_MS = 240_000;
/** Speculative drafts per lap from prompt lookup. */
const MAX_DRAFTS = 4;

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

export interface SessionNode {
  nodeId: string;
  stage: number;
  hops: number;
  tokens: number;
  /** Hops compared against a sibling. */
  checked: number;
  mismatches: number;
  gpuMs: number;
  /** Wall ms at the relay, summed. */
  ms: number;
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
  /** Tokens proposed by lookup drafting and confirmed by the model. */
  draftedTokens: number;
  laps: number;
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
  draftedTokens: number;
  laps: number;
  firstTokenMs: number | null;
  totalMs: number;
  tokPerSec: number | null;
  stages: { stage: number; layers: string; nodes: { id: string; hops: number; gpuMs: number; verified: boolean | null; dropped?: string }[] }[];
  /** "single-tab": one stage held the whole model, so each lap was one hop (still run on two tabs and compared). "pipeline": layers split across stages. */
  topology: "single-tab" | "pipeline";
  /** "replica-tolerance" when every stage had two agreeing nodes for every hop; otherwise "unverified". */
  verification: "replica-tolerance" | "unverified";
  verified: boolean;
  units: { total: number; verified: number };
  finishReason: "stop" | "length" | "error";
  error?: string;
}

export type NetworkChatEvent = { type: "token"; text: string; token: number } | { type: "status"; detail: string };

/* ------------------------------------------------------------------ gateway tokenizer */

const g = globalThis as typeof globalThis & { __brainTokenizers?: Map<string, Promise<Tokenizer>> };

/** Tokenizer for the gateway side. Fetched once per instance (~11 MB JSON for Qwen3). */
export function gatewayTokenizer(model: NetworkModel = DEFAULT_NETWORK_MODEL): Promise<Tokenizer> {
  g.__brainTokenizers ??= new Map();
  let p = g.__brainTokenizers.get(model.tokenizerRepo);
  if (!p) {
    p = (async () => {
      const t0 = Date.now();
      const r = await fetch(tokenizerUrl(model));
      if (!r.ok) throw new Error(`tokenizer ${r.status}`);
      const json = (await r.json()) as TokenizerJson;
      const tok = new Tokenizer(json);
      console.log(`[inference] tokenizer for ${model.tokenizerRepo} loaded in ${Date.now() - t0} ms`);
      return tok;
    })();
    g.__brainTokenizers.set(model.tokenizerRepo, p);
    p.catch(() => g.__brainTokenizers?.delete(model.tokenizerRepo));
  }
  return p;
}

/* ------------------------------------------------------------------ shards */

const isLive = (n: StoredNode, now: number) => (n.status === "idle" || n.status === "computing") && now - n.lastHeartbeatAt <= networkConfig.nodes.offlineAfterMs;

export async function listLiveShards(model: NetworkModel, now = Date.now()): Promise<{ shard: ShardRecord; node: StoredNode }[]> {
  const store = getStore();
  const all = await store.listDocs<ShardRecord>("shard", { limit: 1000 });
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

/** Live shards whose node is both reported ready and connected to the relay (so it can take hops now). */
export async function servingShards(model: NetworkModel, now = Date.now()): Promise<{ shard: ShardRecord; node: StoredNode }[]> {
  const live = await listLiveShards(model, now);
  if (!relayConfigured()) return [];
  const present = new Set((await relayPresence(model.id).catch(() => [])).filter((p) => p.stage !== undefined).map((p) => `${p.nodeId}:${p.stage}`));
  return live.filter((x) => x.shard.state === "ready" && present.has(`${x.shard.nodeId}:${x.shard.stage}`));
}

export interface StageCapacity {
  stage: number;
  layerFrom: number;
  layerTo: number;
  hasEmbed: boolean;
  hasHead: boolean;
  ready: number;
  loading: number;
}

export interface InferenceCapacity {
  model: string;
  modelLabel: string;
  params: string;
  quant: string;
  license: string;
  stages: StageCapacity[];
  /** Every stage has at least one serving node. */
  available: boolean;
  /** Every stage has at least two serving nodes, so every hop can be replica-checked. */
  verifiable: boolean;
  readyNodes: number;
  relay: boolean;
  provenance: "live";
}

export async function inferenceCapacity(model: NetworkModel = DEFAULT_NETWORK_MODEL): Promise<InferenceCapacity> {
  const now = Date.now();
  const [live, serving] = await Promise.all([listLiveShards(model, now), servingShards(model, now)]);
  const stages = stagePlan(model).map((s) => ({
    ...s,
    ready: serving.filter((x) => x.shard.stage === s.stage).length,
    loading: live.filter((x) => x.shard.stage === s.stage && x.shard.state === "loading").length,
  }));
  return {
    model: model.id,
    modelLabel: model.label,
    params: model.params,
    quant: model.quant,
    license: model.license,
    stages,
    available: stages.every((s) => s.ready >= 1),
    verifiable: stages.every((s) => s.ready >= 2),
    readyNodes: stages.reduce((a, s) => a + s.ready, 0),
    relay: relayConfigured(),
    provenance: "live",
  };
}

export async function allCapacity(): Promise<InferenceCapacity[]> {
  return Promise.all(MODEL_PREFERENCE.map((m) => inferenceCapacity(m)));
}

/** The model a chat runs when none is named: the largest that is verifiable, else the largest available. */
export async function pickModel(requested?: NetworkModel): Promise<{ model: NetworkModel; capacity: InferenceCapacity } | null> {
  if (requested) {
    const capacity = await inferenceCapacity(requested);
    return capacity.available ? { model: requested, capacity } : null;
  }
  const caps = await allCapacity();
  const verifiable = caps.find((c) => c.verifiable);
  const available = caps.find((c) => c.available);
  const chosen = verifiable ?? available;
  return chosen ? { model: NETWORK_MODELS[chosen.model], capacity: chosen } : null;
}

/**
 * Which model and stage a node should load. Sticky: a node keeps its assignment while it exists.
 * Otherwise the ladder is filled in order: the first model in MODEL_LADDER with a stage held by
 * fewer than two live nodes that fits this node's GPU gets it (fewest holders first); when every
 * stage of every model has two holders, extra replicas go to the default model's thinnest stage.
 */
export function assignShard(node: StoredNode, requested?: NetworkModel): Promise<{ model: NetworkModel; span: StageSpan; record: ShardRecord }> {
  // Several nodes come online together (a fleet reload); without the lock they would all see the
  // same empty counts and pick the same stage.
  return getStore().withLock("inference:assign", () => assignShardUnlocked(node, requested));
}

async function assignShardUnlocked(node: StoredNode, requested?: NetworkModel): Promise<{ model: NetworkModel; span: StageSpan; record: ShardRecord }> {
  const store = getStore();
  const now = Date.now();
  const existing = await store.getDoc<ShardRecord>("shard", node.id);
  // Nodes registered before the adapter limit was reported: let them try; a stage that does not fit
  // fails at load and is reported as such.
  const maxBuf = node.maxBufferBytes ?? Number.POSITIVE_INFINITY;

  let model: NetworkModel | undefined;
  let span: StageSpan | undefined;
  if (existing && existing.state !== "failed" && (!requested || requested.id === existing.model)) {
    const m = NETWORK_MODELS[existing.model];
    const s = m && stagePlan(m).find((x) => x.stage === existing.stage);
    if (m && s && nodeFitsStage(m, s, maxBuf)) {
      model = m;
      span = s;
    }
  }
  if (!model || !span) {
    const ladder = requested ? [requested] : MODEL_LADDER;
    const counts = new Map<string, number[]>();
    for (const m of ladder) {
      const live = await listLiveShards(m, now);
      counts.set(
        m.id,
        stagePlan(m).map((s) => live.filter((x) => x.shard.stage === s.stage && x.shard.nodeId !== node.id).length),
      );
    }
    const pick = (threshold: number) => {
      for (const m of ladder) {
        const plan = stagePlan(m).filter((s) => nodeFitsStage(m, s, maxBuf));
        const c = counts.get(m.id)!;
        const under = plan.filter((s) => c[s.stage] < threshold).sort((a, b) => c[a.stage] - c[b.stage] || a.stage - b.stage);
        if (under.length) return { m, s: under[0] };
      }
      return null;
    };
    const chosen = pick(2) ?? pick(Infinity);
    if (!chosen) throw new NodeError("no_fit", 409);
    model = chosen.m;
    span = chosen.s;
  }
  const same = existing?.model === model.id && existing.stage === span.stage;
  const record: ShardRecord = {
    nodeId: node.id,
    model: model.id,
    stage: span.stage,
    layerFrom: span.layerFrom,
    layerTo: span.layerTo,
    state: same && existing?.state === "ready" ? "ready" : "loading",
    progress: same ? (existing?.progress ?? 0) : 0,
    updatedAt: now,
    readyAt: same ? existing?.readyAt : undefined,
  };
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

export async function shardOf(node: StoredNode): Promise<ShardRecord | null> {
  return getStore().getDoc<ShardRecord>("shard", node.id);
}

/* ------------------------------------------------------------------ drafting */

/**
 * Prompt-lookup drafts: if the last `n` tokens occurred earlier in the context, propose what
 * followed them then. Free to compute, right surprisingly often on names, code and repeated
 * phrasing, and always checked by the model before a token is emitted.
 */
export function lookupDrafts(ctx: ArrayLike<number>, maxDrafts = MAX_DRAFTS, maxNgram = 3, minNgram = 2): number[] {
  const L = ctx.length;
  for (let n = Math.min(maxNgram, L - 1); n >= minNgram; n--) {
    for (let i = L - n - 1; i >= 0; i--) {
      let match = true;
      for (let j = 0; j < n; j++) {
        if (ctx[i + j] !== ctx[L - n + j]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      const out: number[] = [];
      for (let k = i + n; k < L && out.length < maxDrafts; k++) out.push(ctx[k]);
      if (out.length) return out;
    }
  }
  return [];
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

/**
 * Run one chat completion on the network. Emits tokens as they are sampled and returns the summary
 * once the session is terminal. Throws `NodeError("no_capacity")` before any work if no model has
 * a node for every stage.
 */
export async function runNetworkChat(input: NetworkChatInput, emit: (e: NetworkChatEvent) => void, signal?: AbortSignal): Promise<NetworkRunSummary> {
  const store = getStore();
  const t0 = Date.now();
  if (!relayConfigured()) throw new NodeError("no_capacity:the inference relay is not configured", 503);

  const running = (await store.listDocs<InferenceSession>("isession", { limit: 20, from: t0 - 5 * 60_000 })).filter((s) => s.status === "running" && t0 - s.updatedAt < 30_000);
  if (running.length >= MAX_CONCURRENT_SESSIONS) throw new NodeError("busy", 503);

  const picked = await pickModel(input.model);
  if (!picked) {
    const want = input.model ?? DEFAULT_NETWORK_MODEL;
    const cap = await inferenceCapacity(want);
    const missing = cap.stages.filter((s) => s.ready === 0).map((s) => s.stage);
    throw new NodeError(`no_capacity:${want.label} stage ${missing.join(",")} has no serving node`, 503);
  }
  const { model } = picked;
  const serving = await servingShards(model, t0);
  const plan = stagePlan(model);
  const stages: { span: StageSpan; nodes: string[] }[] = plan.map((span) => ({
    span,
    nodes: serving
      .filter((x) => x.shard.stage === span.stage)
      .sort((a, b) => b.node.reputation - a.node.reputation || b.node.computeScore - a.node.computeScore)
      .slice(0, 2)
      .map((x) => x.node.id),
  }));
  const missing = stages.filter((s) => s.nodes.length === 0).map((s) => s.span.stage);
  if (missing.length) throw new NodeError(`no_capacity:${model.label} stage ${missing.join(",")} has no serving node`, 503);

  emit({ type: "status", detail: `${model.label} · ${stages.map((s) => `${s.nodes.length} node${s.nodes.length === 1 ? "" : "s"}`).join(" → ")}` });
  const tok = await gatewayTokenizer(model);
  const cfg = model.config;
  let promptIds = tok.encode(chatPrompt(input.messages, { noThink: model.noThink }));
  if (promptIds.length > MAX_PROMPT_TOKENS) promptIds = promptIds.slice(promptIds.length - MAX_PROMPT_TOKENS);
  const maxNew = Math.max(1, Math.min(input.maxTokens, model.maxContext - promptIds.length - MAX_DRAFTS - 1));

  const sessionId = `is-${t0.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const session: InferenceSession = {
    id: sessionId,
    model: model.id,
    status: "running",
    createdAt: t0,
    updatedAt: t0,
    promptTokens: promptIds.length,
    outputTokens: 0,
    draftedTokens: 0,
    laps: 0,
    stages: stages.map((s) => ({ stage: s.span.stage, layerFrom: s.span.layerFrom, layerTo: s.span.layerTo, nodes: [...s.nodes] })),
    nodes: {},
    provenance: "live",
  };
  for (const s of stages) for (const n of s.nodes) session.nodes[n] = { nodeId: n, stage: s.span.stage, hops: 0, tokens: 0, checked: 0, mismatches: 0, gpuMs: 0, ms: 0 };
  await store.putDoc("isession", sessionId, session, { at: t0, key: model.id });

  // Per-lap accounting from relay reports. A stage's two reports for one step are paired by step.
  const lapSeq = new Map<number, number>();
  let dispute: string | null = null;
  const onStage = (m: StageMsg) => {
    const sn = session.nodes[m.nodeId];
    if (!sn) return;
    const seq = lapSeq.get(m.step) ?? 1;
    if (m.ok) {
      sn.hops++;
      sn.tokens += seq;
      sn.gpuMs += m.gpuMs;
      sn.ms += m.ms;
    } else if (!sn.dropped) {
      sn.dropped = m.error ?? "failed";
      const st = stages.find((s) => s.span.stage === m.stage);
      if (st) st.nodes = st.nodes.filter((n) => n !== m.nodeId);
    }
    if (m.rms !== null) {
      // Both nodes of this stage answered this step: the comparison counts for both.
      const st = session.stages.find((s) => s.stage === m.stage);
      for (const id of st?.nodes ?? []) {
        const x = session.nodes[id];
        if (!x) continue;
        x.checked++;
        if (m.rms > REPLICA_TOLERANCE) x.mismatches++;
      }
      if (m.rms > REPLICA_TOLERANCE && !dispute) dispute = `stage ${m.stage} replicas disagree (relative RMS ${m.rms.toExponential(1)})`;
    }
  };

  const relay = await RelaySession.connect(model.id, sessionId, onStage);
  const rnd = mulberry32(input.seed ?? (t0 >>> 0));
  const sampling = { temperature: Math.max(0, Math.min(2, input.temperature)), topP: Math.max(0.05, Math.min(1, input.topP)), seed: input.seed ?? 0 };
  const decoder = new StreamDecoder(tok);
  const out: number[] = [];
  let finishReason: NetworkRunSummary["finishReason"] = "length";
  let firstTokenMs: number | null = null;
  let error: string | undefined;
  let step = 0;

  const touch = async () => {
    session.updatedAt = Date.now();
    session.outputTokens = out.length;
    session.laps = step;
    await store.putDoc("isession", sessionId, session, { at: t0, key: model.id });
  };

  const lap = async (tokens: number[], cacheLen: number, hopMs: number) => {
    const planNow: LapStage[] = stages.map((s) => ({ stage: s.span.stage, nodes: s.nodes }));
    const lost = planNow.find((s) => s.nodes.length === 0);
    if (lost) throw new NodeError(`stage ${lost.stage} lost: no serving node left`, 503);
    const positions = tokens.map((_, i) => cacheLen + i);
    lapSeq.set(step, tokens.length);
    const r = await relay.lap(step, planNow, Uint32Array.from(tokens), positions, cacheLen, hopMs, signal);
    step++;
    return unpackTopK(r.topk);
  };

  try {
    // Prefill: the whole prompt in one lap; the last column's top-k gives the first token.
    const tp = Date.now();
    const pre = await lap(promptIds, 0, PREFILL_HOP_MS + promptIds.length * 20);
    console.log(`[inference] ${sessionId} ${model.id} prefill ${promptIds.length} tokens in ${Date.now() - tp} ms`);
    let cacheLen = promptIds.length;
    const ctx = [...promptIds];
    let last = sampleTopK(pre[pre.length - 1], sampling, rnd);
    const emitTok = (t: number) => {
      out.push(t);
      ctx.push(t);
      if (firstTokenMs == null) firstTokenMs = Date.now() - t0;
      const text = decoder.push(t);
      if (text) emit({ type: "token", text, token: t });
    };
    if (cfg.eos.includes(last)) finishReason = "stop";
    else emitTok(last);

    while (finishReason !== "stop" && out.length < maxNew) {
      if (signal?.aborted) throw new NodeError("aborted", 499);
      if (Date.now() - t0 > SESSION_BUDGET_MS) break;
      if (dispute) throw new NodeError(`replica-dispute: ${dispute}`, 502);
      const drafts = lookupDrafts(ctx, Math.min(MAX_DRAFTS, maxNew - out.length));
      const tokens = [last, ...drafts];
      const cols = await lap(tokens, cacheLen, DECODE_HOP_MS);
      // Column j predicts the token after tokens[j]. Accept drafts while the model's own sample agrees.
      let accepted = 0;
      let next = -1;
      for (let j = 0; j < cols.length; j++) {
        const s = sampleTopK(cols[j], sampling, rnd);
        next = s;
        if (cfg.eos.includes(s)) {
          finishReason = "stop";
          break;
        }
        if (j < drafts.length && drafts[j] === s) {
          accepted++;
          emitTok(s);
          if (out.length >= maxNew) break;
          continue;
        }
        emitTok(s);
        break;
      }
      session.draftedTokens += accepted;
      // Committed to every node's cache: `last` plus the accepted drafts; the rest is rolled back by the next lap.
      cacheLen += 1 + accepted;
      last = next;
      if (step % 4 === 0) await touch();
    }
    const tail = decoder.flush();
    if (tail) emit({ type: "token", text: tail, token: -1 });
  } catch (e) {
    finishReason = "error";
    error = e instanceof Error ? e.message : String(e);
    console.warn(`[inference] ${sessionId} failed after ${out.length} tokens: ${error}`);
  }

  // Give late replica reports a moment to land before settling.
  await new Promise((r) => setTimeout(r, 400));
  relay.end();
  const totalMs = Date.now() - t0;
  session.status = finishReason === "error" ? "failed" : "completed";
  session.finishReason = finishReason;
  session.error = error;
  session.firstTokenMs = firstTokenMs ?? undefined;
  session.totalMs = totalMs;
  session.outputTokens = out.length;
  session.laps = step;
  session.updatedAt = Date.now();
  await store.putDoc("isession", sessionId, session, { at: t0, key: model.id });
  return settleSession(model, session);
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
  const plan = stagePlan(model);
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
    const span = plan.find((p) => p.stage === sn.stage) ?? { layerFrom: st.layerFrom, layerTo: st.layerTo, hasHead: false };
    const units = stageUnits(cfg, span, sn.tokens);
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
        {
          stage: "submitted",
          at: session.createdAt,
          detail: isSingleTab(model)
            ? `network inference session ${session.id}, ${model.label}: whole model on one tab (layers ${st.layerFrom}–${st.layerTo - 1} + embedding + head), replica-checked against a second tab`
            : `network inference session ${session.id}, ${model.label} stage ${sn.stage} (layers ${st.layerFrom}–${st.layerTo - 1}${span.hasHead ? " + head" : ""})`,
        },
        { stage: "executing", at: session.createdAt, detail: `${sn.hops} hops · ${sn.tokens} token-columns · client GPU ${Math.round(sn.gpuMs)} ms (reported) · relay ${Math.round(sn.ms)} ms` },
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
    draftedTokens: session.draftedTokens ?? 0,
    laps: session.laps ?? 0,
    firstTokenMs: session.firstTokenMs ?? null,
    totalMs: session.totalMs ?? 0,
    tokPerSec,
    stages,
    topology: isSingleTab(model) ? "single-tab" : "pipeline",
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
  const [models, sessions] = await Promise.all([allCapacity(), recentSessions(50)]);
  const completed = sessions.filter((s) => s.status === "completed");
  const tokens = completed.reduce((a, s) => a + s.outputTokens, 0);
  const secs = completed.reduce((a, s) => a + Math.max(0, (s.totalMs ?? 0) - (s.firstTokenMs ?? 0)), 0) / 1000;
  const serving = models.find((m) => m.verifiable) ?? models.find((m) => m.available) ?? null;
  return {
    /** The model a NETWORK chat would run right now, or null. */
    serving: serving?.model ?? null,
    models,
    /** Kept for older clients: the capacity of the model currently served (or the default). */
    capacity: serving ?? models.find((m) => m.model === DEFAULT_NETWORK_MODEL.id) ?? models[0],
    sessions: { recent: sessions.length, completed: completed.length, failed: sessions.filter((s) => s.status === "failed").length, running: sessions.filter((s) => s.status === "running" && Date.now() - s.updatedAt < 30_000).length },
    outputTokens: tokens,
    /** Decode throughput across recent completed sessions; null until there is data. */
    tokPerSec: completed.length && secs > 0 ? +((tokens - completed.length) / secs).toFixed(2) : null,
    relay: relayConfigured(),
    provenance: "live" as const,
  };
}
