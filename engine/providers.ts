import "server-only";
import type { Capability, ComputeReceipt, ExecutionEstimate, ExecutionRequest, ExecutionResult, ExecutionTarget, Money, ProviderHealth, ProviderTrust } from "@/domain/economy";
import { networkConfig } from "@/lib/config";
import { priceForComputeUnits, priceForTokens, tokenListPricePer1MUsd, upstreamPricePer1MUsd } from "@/lib/pricing";
import { workloadUnits } from "@/network/workloads";
import { OpenAICompatibleProvider } from "@/providers/openaiCompatible";
import { accrueReceipt } from "@/services/accounting";
import { createJob, getJob, listJobs } from "@/services/distributed";
import { eventBus } from "@/services/eventBus";
import { liveNodes } from "@/services/nodes";
import { sha256 } from "@/services/receipts";
import { getStore } from "@/services/store";
import { providerStats, recordSample } from "./metrics";

/**
 * Intelligence providers = execution supply. BRAIN AUTO calls `estimate()` on all of them,
 * applies hard constraints (capability, availability, privacy, budget), scores the rest, then
 * `execute()`s the winner and falls through the ranked list on failure.
 *
 * Estimates are built from measurements (engine/metrics.ts) and configuration (lib/pricing.ts);
 * anything not measured or configured is reported as null = UNKNOWN. No provider hardcodes a
 * number the UI then presents as fact.
 */
export interface IntelligenceProvider {
  readonly id: string;
  /** Class of supply. */
  readonly type: ExecutionTarget;
  readonly capabilities: readonly Capability[];
  /** Who could read plaintext sent here. Used by the privacy constraint. */
  readonly trust: ProviderTrust;
  estimate(request: ExecutionRequest): Promise<ExecutionEstimate>;
  execute(request: ExecutionRequest, ctx: ExecutionContext): Promise<ExecutionResult>;
  /** Optional token streaming. The returned `done` resolves after the receipt is issued. */
  executeStream?(request: Extract<ExecutionRequest, { kind: "chat" }>, ctx: ExecutionContext): Promise<{ upstream: ReadableStream<Uint8Array>; done: Promise<ExecutionResult> }>;
  health(): Promise<ProviderHealth>;
}
/** @deprecated alias kept for existing imports. */
export type ExecutionProvider = IntelligenceProvider;

export interface ExecutionContext {
  orderId: string;
  decisionId: string;
  customerId: string;
  planId?: string;
  stepId?: string;
}

const cfg = networkConfig.distributed;

const qualityTier = (v: string | undefined): number | null => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
};

/* ------------------------------------------------------------ browser network */

export class BrowserNetworkExecutionProvider implements IntelligenceProvider {
  readonly id = "brain-browser-pool";
  readonly type = "BROWSER_NETWORK" as const;
  readonly capabilities = ["compute.matmul_u32"] as const;
  readonly trust = "untrusted-distributed" as const;

  private unitsFor(req: Extract<ExecutionRequest, { kind: "compute" }>, nodes: number) {
    const dims = cfg.sizes[req.size];
    const perUnit = workloadUnits({ kernel: "matmul_u32", m: dims.m, n: dims.n, k: dims.k, seedA: 0, seedB: 0 });
    const perNode = Math.min(16, Math.max(1, req.unitsPerNode ?? cfg.defaultUnitsPerNode));
    const count = Math.min(cfg.maxUnits, nodes * perNode);
    return { count, total: count * perUnit * (req.redundancy === 2 ? 2 : 1) };
  }

  async estimate(req: ExecutionRequest): Promise<ExecutionEstimate> {
    const nodes = await liveNodes();
    const notes: string[] = [];
    const base = { provider: this.id, target: this.type, availableCapacity: Math.min(1, nodes.length / 10), available: nodes.length > 0, qualityTier: null };
    if (nodes.length === 0) notes.push("no real nodes online");
    if (req.kind !== "compute") {
      notes.push("browser network runs verified parallel matmul only; LLM inference is not available on it yet");
      return { ...base, model: null, supported: false, estimatedCost: null, costBasis: null, estimatedLatency: null, latencyBasis: null, confidence: 0, estimatedReliability: 0, notes };
    }
    const { total } = this.unitsFor(req, Math.max(1, nodes.length));
    const cost = priceForComputeUnits(total);
    if (cost == null) notes.push("UNKNOWN cost: BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS not configured");
    const jobs = await listJobs(50);
    const recent = jobs.filter((j) => j.size === req.size && j.status === "completed" && j.totals.latencyMs != null);
    const lat = recent.map((j) => j.totals.latencyMs!).sort((a, b) => a - b);
    const med = lat.length ? (lat.length % 2 ? lat[lat.length >> 1] : (lat[lat.length / 2 - 1] + lat[lat.length / 2]) / 2) : null;
    if (med == null) notes.push(`UNKNOWN latency: no completed ${req.size} jobs measured yet`);
    const all = jobs.filter((j) => j.status === "completed" || j.status === "failed");
    const reliability = all.length ? all.filter((j) => j.status === "completed").length / all.length : nodes.reduce((s, n) => s + n.reputation, 0) / Math.max(1, nodes.length);
    if (!all.length) notes.push("reliability from node reputation (no completed jobs yet)");
    return {
      ...base,
      model: "brain/matmul-u32",
      supported: true,
      estimatedCost: cost,
      costBasis: cost == null ? null : "list-price",
      estimatedLatency: med,
      latencyBasis: med == null ? null : "measured-median",
      confidence: (cost != null ? 0.5 : 0.2) + (med != null ? 0.4 : 0.1),
      estimatedReliability: reliability,
      notes,
    };
  }

  async execute(req: ExecutionRequest, ctx: ExecutionContext): Promise<ExecutionResult> {
    if (req.kind !== "compute") throw new Error("browser network: unsupported request kind");
    const t0 = Date.now();
    const job = await createJob({ size: req.size, unitsPerNode: req.unitsPerNode, redundancy: req.redundancy, orderId: ctx.orderId, decisionId: ctx.decisionId });
    // Wait for settle(): the job is driven by real nodes; we only observe.
    const deadline = t0 + cfg.jobTtlMs + 5_000;
    let cur = job;
    while (cur.status !== "completed" && cur.status !== "failed") {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 150));
      cur = (await getJob(job.id)) ?? cur;
    }
    const ok = cur.status === "completed";
    const ms = (cur.completedAt ?? Date.now()) - t0;
    await recordSample({ providerId: this.id, at: Date.now(), latencyMs: ms, ok, units: cur.totals.computeUnits, error: ok ? undefined : (cur.failReason ?? "timeout") });
    const cost = ok ? priceForComputeUnits(cur.totals.computeUnits) : null;
    return {
      ok,
      provider: this.id,
      target: this.type,
      model: "brain/matmul-u32",
      jobId: job.id,
      receiptId: `r-${job.id}`,
      executionTimeMs: ms,
      usage: { inputUnits: cur.totals.workUnits, outputUnits: cur.totals.computeUnits },
      cost: cost == null ? null : { amount: cost, currency: "USD", basis: "list-price" },
      error: ok ? undefined : (cur.failReason ?? "timeout"),
    };
  }

  async health(): Promise<ProviderHealth> {
    const nodes = await liveNodes();
    const st = await providerStats(this.id);
    return {
      provider: this.id,
      target: this.type,
      status: nodes.length === 0 ? "DOWN" : st.reliability != null && st.reliability < 0.8 ? "DEGRADED" : "UP",
      detail: nodes.length === 0 ? "no real nodes online" : `${nodes.length} real nodes · ${st.samples} measured jobs`,
      checkedAt: Date.now(),
    };
  }
}

/* ------------------------------------------------------------ native network (not connected) */

/**
 * Community machines running a native worker. The protocol does not exist yet, so this provider
 * is honest about it: never supported, never available, health UNCONFIGURED. It exists so the
 * router, the topology and /capacity show the slot without faking supply.
 */
export class NativeNetworkExecutionProvider implements IntelligenceProvider {
  readonly id = "brain-native-pool";
  readonly type = "NATIVE_NETWORK" as const;
  readonly capabilities = [] as const;
  readonly trust = "untrusted-distributed" as const;
  async estimate(): Promise<ExecutionEstimate> {
    return { provider: this.id, target: this.type, model: null, supported: false, available: false, estimatedCost: null, costBasis: null, estimatedLatency: null, latencyBasis: null, estimatedReliability: 0, availableCapacity: 0, qualityTier: null, confidence: 0, notes: ["native worker protocol not implemented; no native nodes can connect yet"] };
  }
  async execute(): Promise<ExecutionResult> {
    throw new Error("native network: not connected");
  }
  async health(): Promise<ProviderHealth> {
    return { provider: this.id, target: this.type, status: "UNCONFIGURED", detail: "native worker protocol not implemented", checkedAt: Date.now() };
  }
}

/* ------------------------------------------------------------ OpenAI-compatible upstreams */

interface UpstreamEnv {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  qualityTier?: string;
}

export class UpstreamExecutionProvider implements IntelligenceProvider {
  readonly id: "cloud-fallback" | "external";
  readonly type: ExecutionTarget;
  readonly capabilities = ["chat"] as const;
  readonly trust: ProviderTrust;
  private inner: OpenAICompatibleProvider;
  private configured: boolean;
  private model: string | null;
  private tier: number | null;

  constructor(id: "cloud-fallback" | "external", type: ExecutionTarget, env: UpstreamEnv) {
    this.id = id;
    this.type = type;
    this.trust = type === "CLOUD_GPU" ? "operator" : "third-party";
    this.configured = Boolean(env.baseUrl && env.apiKey && env.model);
    this.model = env.model ?? null;
    this.tier = qualityTier(env.qualityTier);
    this.inner = new OpenAICompatibleProvider({ id, baseUrl: env.baseUrl, apiKey: env.apiKey, model: env.model });
  }

  private tokensFor(req: Extract<ExecutionRequest, { kind: "chat" }>) {
    const promptChars = req.messages.reduce((s, m) => s + m.content.length, 0);
    return Math.ceil(promptChars / 4) + (req.maxTokens ?? 512);
  }

  async estimate(req: ExecutionRequest): Promise<ExecutionEstimate> {
    const notes: string[] = [];
    const st = await providerStats(this.id);
    const base = { provider: this.id, target: this.type, availableCapacity: this.configured ? 1 : 0, available: this.configured, qualityTier: this.tier };
    if (!this.configured) notes.push("not configured on this server (env credentials unset)");
    if (this.tier == null) notes.push("UNKNOWN quality tier: BRAIN_*_QUALITY_TIER not configured");
    if (req.kind !== "chat") {
      notes.push("upstream providers execute chat models only");
      return { ...base, model: null, supported: false, estimatedCost: null, costBasis: null, estimatedLatency: null, latencyBasis: null, confidence: 0, estimatedReliability: st.reliability ?? 0, notes };
    }
    const per1M = upstreamPricePer1MUsd(this.id);
    const cost = priceForTokens(this.tokensFor(req), per1M);
    if (cost == null) notes.push(`UNKNOWN cost: ${this.id === "cloud-fallback" ? "BRAIN_FALLBACK_PRICE_USD_PER_1M" : "BRAIN_EXTERNAL_PRICE_USD_PER_1M"} not configured`);
    if (st.medianLatencyMs == null) notes.push("UNKNOWN latency: no measured requests yet");
    return {
      ...base,
      model: this.model,
      supported: true,
      estimatedCost: cost,
      costBasis: cost == null ? null : "provider-price",
      estimatedLatency: st.medianLatencyMs,
      latencyBasis: st.medianLatencyMs == null ? null : "measured-median",
      confidence: (cost != null ? 0.5 : 0.2) + (st.medianLatencyMs != null ? 0.4 : 0.1),
      estimatedReliability: st.reliability ?? (this.configured ? 0.5 : 0),
      notes,
    };
  }

  /** Issues the receipt and accounting lines for a completed chat turn. Shared by execute and executeStream. */
  private async issueReceipt(req: Extract<ExecutionRequest, { kind: "chat" }>, ctx: ExecutionContext, t0: number, jobId: string, content: string, usage: { prompt: number; completion: number; total: number; basis: "provider-reported" | "estimated-from-chars"; costUsd?: number | null }) {
    const ms = Date.now() - t0;
    await recordSample({ providerId: this.id, at: Date.now(), latencyMs: ms, ok: true, units: usage.total });
    const listPrice = priceForTokens(usage.total, tokenListPricePer1MUsd());
    // Prefer the upstream's own reported charge for this request (OpenRouter sends `usage.cost`); fall back to the configured rate.
    const upstreamCost = usage.costUsd != null && Number.isFinite(usage.costUsd) ? usage.costUsd : priceForTokens(usage.total, upstreamPricePer1MUsd(this.id));
    const customerCost: Money | null = listPrice == null ? null : { amount: listPrice, currency: "USD", basis: "list-price" };
    const receipt: ComputeReceipt = {
      receiptId: `r-${jobId}`,
      jobId,
      workloadType: "chat",
      model: this.model ?? req.model,
      createdAt: t0,
      completedAt: Date.now(),
      nodesUsed: [],
      workUnits: 1,
      verifiedWorkUnits: 0,
      failedWorkUnits: 0,
      reassignedWorkUnits: 0,
      totalComputeUnits: 0,
      executionTimeMs: ms,
      verificationMethod: "unverified-provider-response",
      verificationConfidence: 0,
      resultHash: sha256(`brain-receipt-v1|${jobId}|${content}`),
      resultHashLabel: "sha256 of provider response",
      attestation: { kind: "none" },
      source: "REAL",
      customerCost,
      providerCompensation: null,
      // What BRAIN keeps is list price minus what the upstream charges; unknown if either is unknown.
      protocolRevenue: listPrice == null || upstreamCost == null ? null : { amount: Math.max(0, listPrice - upstreamCost), currency: "USD", basis: usage.costUsd != null ? "provider-reported" : "provider-price" },
      route: { target: this.type, providerId: this.id, decisionId: ctx.decisionId },
      orderId: ctx.orderId,
      planId: ctx.planId,
      stepId: ctx.stepId,
      status: "VERIFIED",
    };
    await getStore().putDoc("receipt", receipt.receiptId, receipt, { at: receipt.completedAt, key: receipt.source });
    eventBus.publish({ type: "receipt.issued", at: receipt.completedAt, receipt });
    await accrueReceipt(receipt, {}, { upstreamCost, usageBasis: usage.basis });
    const result: ExecutionResult = { ok: true, provider: this.id, target: this.type, model: receipt.model, jobId, receiptId: receipt.receiptId, executionTimeMs: ms, content, usage: { inputUnits: usage.prompt, outputUnits: usage.completion }, cost: customerCost };
    return result;
  }

  private failure(t0: number, jobId: string, e: unknown): ExecutionResult {
    const msg = e instanceof Error ? e.message : "error";
    const safe = /^upstream \d{3}$/.test(msg) ? msg : e instanceof Error && e.name === "AbortError" ? "timeout" : "unreachable";
    void recordSample({ providerId: this.id, at: Date.now(), latencyMs: Date.now() - t0, ok: false, units: 0, error: safe });
    return { ok: false, provider: this.id, target: this.type, jobId, receiptId: "", executionTimeMs: Date.now() - t0, error: safe };
  }

  async execute(req: ExecutionRequest, ctx: ExecutionContext): Promise<ExecutionResult> {
    if (req.kind !== "chat") throw new Error("upstream: unsupported request kind");
    const t0 = Date.now();
    const jobId = `c-${t0.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      const out = await this.inner.complete({ model: req.model, messages: req.messages, max_tokens: req.maxTokens, temperature: req.temperature });
      return await this.issueReceipt(req, ctx, t0, jobId, out.content, { prompt: out.usage.prompt_tokens, completion: out.usage.completion_tokens, total: out.usage.total_tokens, basis: "provider-reported", costUsd: out.usage.cost ?? null });
    } catch (e) {
      return this.failure(t0, jobId, e);
    }
  }

  /**
   * Streams tokens to the caller while accumulating the full response server-side. When the
   * upstream closes, the same receipt + accounting path as execute() runs. Token usage comes from
   * the upstream's final usage chunk when present (OpenAI `stream_options.include_usage`), else it
   * is estimated from characters and the receipt says so.
   */
  async executeStream(req: Extract<ExecutionRequest, { kind: "chat" }>, ctx: ExecutionContext) {
    const t0 = Date.now();
    const jobId = `c-${t0.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const upstream = await this.inner.stream({ model: req.model, messages: req.messages, max_tokens: req.maxTokens, temperature: req.temperature, stream: true });
    let resolveDone!: (r: ExecutionResult) => void;
    const done = new Promise<ExecutionResult>((r) => (resolveDone = r));
    const dec = new TextDecoder();
    let buf = "";
    let content = "";
    let usage: { prompt: number; completion: number; total: number; costUsd?: number | null } | null = null;
    const promptChars = req.messages.reduce((s, m) => s + m.content.length, 0);
    const finish = async () => {
      const u = usage ?? { prompt: Math.ceil(promptChars / 4), completion: Math.ceil(content.length / 4), total: Math.ceil(promptChars / 4) + Math.ceil(content.length / 4) };
      try {
        resolveDone(await this.issueReceipt(req, ctx, t0, jobId, content, { ...u, basis: usage ? "provider-reported" : "estimated-from-chars" }));
      } catch (e) {
        resolveDone(this.failure(t0, jobId, e));
      }
    };
    const tapped = upstream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, ctl) => {
          ctl.enqueue(chunk);
          buf += dec.decode(chunk, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const l of lines) {
            if (!l.startsWith("data:")) continue;
            const payload = l.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const j = JSON.parse(payload);
              const delta = j.choices?.[0]?.delta?.content;
              if (typeof delta === "string") content += delta;
              if (j.usage && typeof j.usage.total_tokens === "number") usage = { prompt: j.usage.prompt_tokens ?? 0, completion: j.usage.completion_tokens ?? 0, total: j.usage.total_tokens, costUsd: typeof j.usage.cost === "number" ? j.usage.cost : null };
            } catch {
              /* partial json line; ignore */
            }
          }
        },
        flush: () => void finish(),
      }),
    );
    return { upstream: tapped, done };
  }

  async health(): Promise<ProviderHealth> {
    const st = await providerStats(this.id);
    const status: ProviderHealth["status"] = !this.configured ? "UNCONFIGURED" : st.reliability == null ? "UP" : st.reliability < 0.5 ? "DOWN" : st.reliability < 0.9 ? "DEGRADED" : "UP";
    return { provider: this.id, target: this.type, status, detail: !this.configured ? "set env credentials to enable" : `${st.samples} measured requests${st.lastError ? ` · last error ${st.lastError}` : ""}`, checkedAt: Date.now() };
  }
}

export function executionProviders(): IntelligenceProvider[] {
  const env = process.env;
  return [
    new BrowserNetworkExecutionProvider(),
    new NativeNetworkExecutionProvider(),
    new UpstreamExecutionProvider("cloud-fallback", "CLOUD_GPU", { baseUrl: env.BRAIN_FALLBACK_BASE_URL, apiKey: env.BRAIN_FALLBACK_API_KEY, model: env.BRAIN_FALLBACK_MODEL, qualityTier: env.BRAIN_FALLBACK_QUALITY_TIER }),
    new UpstreamExecutionProvider("external", "EXTERNAL_MODEL", { baseUrl: env.BRAIN_EXTERNAL_BASE_URL, apiKey: env.BRAIN_EXTERNAL_API_KEY, model: env.BRAIN_EXTERNAL_MODEL, qualityTier: env.BRAIN_EXTERNAL_QUALITY_TIER }),
  ];
}
