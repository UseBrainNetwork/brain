import "server-only";
import type { ExecutionEstimate, ExecutionRequest, ExecutionResult, ExecutionTarget, ProviderHealth, ComputeReceipt } from "@/domain/economy";
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
 * Execution providers. The router calls `estimate()` on all of them, picks one, then `execute()`.
 * Estimates are built from measurements (engine/metrics.ts) and configuration (lib/pricing.ts);
 * anything we have not measured or configured is reported as null = UNKNOWN.
 */
export interface ExecutionProvider {
  readonly id: string;
  readonly target: ExecutionTarget;
  estimate(request: ExecutionRequest): Promise<ExecutionEstimate>;
  execute(request: ExecutionRequest, ctx: ExecutionContext): Promise<ExecutionResult>;
  health(): Promise<ProviderHealth>;
}

export interface ExecutionContext {
  orderId: string;
  decisionId: string;
  customerId: string;
}

const cfg = networkConfig.distributed;

/* ------------------------------------------------------------ browser network */

export class BrowserNetworkExecutionProvider implements ExecutionProvider {
  readonly id = "brain-browser-pool";
  readonly target = "BROWSER_NETWORK" as const;

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
    const base = { provider: this.id, target: this.target, capacity: Math.min(1, nodes.length / 10), available: nodes.length > 0 };
    if (nodes.length === 0) notes.push("no real nodes online");
    if (req.kind !== "compute") {
      notes.push("browser network runs verified parallel matmul only; LLM inference is not available on it yet");
      return { ...base, modelSupported: false, estimatedCost: null, costBasis: null, estimatedLatency: null, latencyBasis: null, confidence: 0, reliability: 0, notes };
    }
    const { total } = this.unitsFor(req, Math.max(1, nodes.length));
    const cost = priceForComputeUnits(total);
    if (cost == null) notes.push("UNKNOWN cost: BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS not configured");
    // Latency: median of recent completed jobs of the same size on this server.
    const recent = (await listJobs(50)).filter((j) => j.size === req.size && j.status === "completed" && j.totals.latencyMs != null);
    const lat = recent.map((j) => j.totals.latencyMs!).sort((a, b) => a - b);
    const med = lat.length ? (lat.length % 2 ? lat[lat.length >> 1] : (lat[lat.length / 2 - 1] + lat[lat.length / 2]) / 2) : null;
    if (med == null) notes.push(`UNKNOWN latency: no completed ${req.size} jobs measured yet`);
    const all = (await listJobs(50)).filter((j) => j.status === "completed" || j.status === "failed");
    const reliability = all.length ? all.filter((j) => j.status === "completed").length / all.length : nodes.reduce((s, n) => s + n.reputation, 0) / Math.max(1, nodes.length);
    if (!all.length) notes.push("reliability from node reputation (no completed jobs yet)");
    return {
      ...base,
      modelSupported: true,
      estimatedCost: cost,
      costBasis: cost == null ? null : "list-price",
      estimatedLatency: med,
      latencyBasis: med == null ? null : "measured-median",
      confidence: (cost != null ? 0.5 : 0.2) + (med != null ? 0.4 : 0.1),
      reliability,
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
    return { ok, provider: this.id, target: this.target, jobId: job.id, receiptId: `r-${job.id}`, executionTimeMs: ms, usage: { inputUnits: cur.totals.workUnits, outputUnits: cur.totals.computeUnits }, error: ok ? undefined : (cur.failReason ?? "timeout") };
  }

  async health(): Promise<ProviderHealth> {
    const nodes = await liveNodes();
    const st = await providerStats(this.id);
    return {
      provider: this.id,
      target: this.target,
      status: nodes.length === 0 ? "DOWN" : st.reliability != null && st.reliability < 0.8 ? "DEGRADED" : "UP",
      detail: nodes.length === 0 ? "no real nodes online" : `${nodes.length} real nodes · ${st.samples} measured jobs`,
      checkedAt: Date.now(),
    };
  }
}

/* ------------------------------------------------------------ OpenAI-compatible upstreams */

export class UpstreamExecutionProvider implements ExecutionProvider {
  readonly id: "cloud-fallback" | "external";
  readonly target: ExecutionTarget;
  private inner: OpenAICompatibleProvider;
  private configured: boolean;

  constructor(id: "cloud-fallback" | "external", target: ExecutionTarget, env: { baseUrl?: string; apiKey?: string; model?: string }) {
    this.id = id;
    this.target = target;
    this.configured = Boolean(env.baseUrl && env.apiKey && env.model);
    this.inner = new OpenAICompatibleProvider({ id, target: target === "CLOUD_GPU" ? "CLOUD_FALLBACK" : "EXTERNAL_MODEL_PROVIDER", ...env, estLatencyMs: 0, costPer1M: null, reliability: 0 });
  }

  private tokensFor(req: Extract<ExecutionRequest, { kind: "chat" }>) {
    const promptChars = req.messages.reduce((s, m) => s + m.content.length, 0);
    return Math.ceil(promptChars / 4) + (req.maxTokens ?? 512);
  }

  async estimate(req: ExecutionRequest): Promise<ExecutionEstimate> {
    const notes: string[] = [];
    const st = await providerStats(this.id);
    const base = { provider: this.id, target: this.target, capacity: this.configured ? 1 : 0, available: this.configured };
    if (!this.configured) notes.push("not configured on this server (env credentials unset)");
    if (req.kind !== "chat") {
      notes.push("upstream providers execute chat models only");
      return { ...base, modelSupported: false, estimatedCost: null, costBasis: null, estimatedLatency: null, latencyBasis: null, confidence: 0, reliability: st.reliability ?? 0, notes };
    }
    const per1M = upstreamPricePer1MUsd(this.id);
    const cost = priceForTokens(this.tokensFor(req), per1M);
    if (cost == null) notes.push(`UNKNOWN cost: ${this.id === "cloud-fallback" ? "BRAIN_FALLBACK_PRICE_USD_PER_1M" : "BRAIN_EXTERNAL_PRICE_USD_PER_1M"} not configured`);
    if (st.medianLatencyMs == null) notes.push("UNKNOWN latency: no measured requests yet");
    return {
      ...base,
      modelSupported: true,
      estimatedCost: cost,
      costBasis: cost == null ? null : "provider-price",
      estimatedLatency: st.medianLatencyMs,
      latencyBasis: st.medianLatencyMs == null ? null : "measured-median",
      confidence: (cost != null ? 0.5 : 0.2) + (st.medianLatencyMs != null ? 0.4 : 0.1),
      reliability: st.reliability ?? (this.configured ? 0.5 : 0),
      notes,
    };
  }

  async execute(req: ExecutionRequest, ctx: ExecutionContext): Promise<ExecutionResult> {
    if (req.kind !== "chat") throw new Error("upstream: unsupported request kind");
    const t0 = Date.now();
    const jobId = `c-${t0.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      const out = await this.inner.complete({ model: req.model, messages: req.messages, max_tokens: req.maxTokens, temperature: req.temperature });
      const ms = Date.now() - t0;
      await recordSample({ providerId: this.id, at: Date.now(), latencyMs: ms, ok: true, units: out.usage.total_tokens });
      const tokens = out.usage.total_tokens;
      const listPrice = priceForTokens(tokens, tokenListPricePer1MUsd());
      const upstreamCost = priceForTokens(tokens, upstreamPricePer1MUsd(this.id));
      const receipt: ComputeReceipt = {
        receiptId: `r-${jobId}`,
        jobId,
        workloadType: "chat",
        model: req.model,
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
        resultHash: sha256(`brain-receipt-v1|${jobId}|${out.content}`),
        resultHashLabel: "sha256 of provider response",
        attestation: { kind: "none" },
        source: "REAL",
        customerCost: listPrice == null ? null : { amount: listPrice, currency: "USD", basis: "list-price" },
        providerCompensation: null,
        // What BRAIN keeps is list price minus what the upstream charges; unknown if either is unknown.
        protocolRevenue: listPrice == null || upstreamCost == null ? null : { amount: Math.max(0, listPrice - upstreamCost), currency: "USD", basis: "provider-price" },
        route: { target: this.target, providerId: this.id, decisionId: ctx.decisionId },
        orderId: ctx.orderId,
        status: "VERIFIED",
      };
      // Chat has no browser nodes to credit; only customer/protocol/infrastructure lines accrue.
      await getStore().putDoc("receipt", receipt.receiptId, receipt, { at: receipt.completedAt, key: receipt.source });
      eventBus.publish({ type: "receipt.issued", at: receipt.completedAt, receipt });
      await accrueReceipt(receipt, {});
      return { ok: true, provider: this.id, target: this.target, jobId, receiptId: receipt.receiptId, executionTimeMs: ms, content: out.content, usage: { inputUnits: out.usage.prompt_tokens, outputUnits: out.usage.completion_tokens } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      const safe = /^upstream \d{3}$/.test(msg) ? msg : e instanceof Error && e.name === "AbortError" ? "timeout" : "unreachable";
      await recordSample({ providerId: this.id, at: Date.now(), latencyMs: Date.now() - t0, ok: false, units: 0, error: safe });
      return { ok: false, provider: this.id, target: this.target, jobId, receiptId: "", executionTimeMs: Date.now() - t0, error: safe };
    }
  }

  async health(): Promise<ProviderHealth> {
    const st = await providerStats(this.id);
    const status: ProviderHealth["status"] = !this.configured ? "UNCONFIGURED" : st.reliability == null ? "UP" : st.reliability < 0.5 ? "DOWN" : st.reliability < 0.9 ? "DEGRADED" : "UP";
    return { provider: this.id, target: this.target, status, detail: !this.configured ? "set env credentials to enable" : `${st.samples} measured requests${st.lastError ? ` · last error ${st.lastError}` : ""}`, checkedAt: Date.now() };
  }
}

export function executionProviders(): ExecutionProvider[] {
  const env = process.env;
  return [
    new BrowserNetworkExecutionProvider(),
    new UpstreamExecutionProvider("cloud-fallback", "CLOUD_GPU", { baseUrl: env.BRAIN_FALLBACK_BASE_URL, apiKey: env.BRAIN_FALLBACK_API_KEY, model: env.BRAIN_FALLBACK_MODEL }),
    new UpstreamExecutionProvider("external", "EXTERNAL_PROVIDER", { baseUrl: env.BRAIN_EXTERNAL_BASE_URL, apiKey: env.BRAIN_EXTERNAL_API_KEY, model: env.BRAIN_EXTERNAL_MODEL }),
  ];
}
