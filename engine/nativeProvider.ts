import "server-only";
import { chatChars } from "@/domain/chat";
import type { ExecutionEstimate, ExecutionRequest, ExecutionResult, ProviderHealth } from "@/domain/economy";
import { priceForTokens, tokenListPricePer1MUsd } from "@/lib/pricing";
import { MODEL_ALLOWLIST, isAllowedModel } from "@/node/models";
import type { ChatTurn } from "@/node/protocol";
import { createInferenceJob, failUnmatched, matchJob, observeJob, scrubInferenceJob, type InferenceJob } from "@/services/coordinator/jobs";
import { routableNativeNodes } from "@/services/coordinator/registry";
import { getReceipt } from "@/services/receipts";
import { routeToNativeNode } from "@/services/router/select";
import { recordSample, providerStats } from "./metrics";
import type { ExecutionContext, IntelligenceProvider } from "./providers";

/**
 * NATIVE_NETWORK supply: machines running the Brain Node agent (node/). This provider is the
 * bridge between BRAIN AUTO (engine/) and the coordinator (services/coordinator): it estimates
 * from the live registry, creates a job, lets the router pick a node, and turns the job's
 * progress into an OpenAI-shaped SSE stream. It never runs a model itself and never guesses
 * capacity: no eligible node → not available, with the router's reason.
 */

/** Token budget cap for any job sent to a community node; app/api/chat applies the same figure. */
export const NATIVE_MAX_TOKENS = 768;

export class NativeNetworkExecutionProvider implements IntelligenceProvider {
  readonly id = "brain-native-pool";
  readonly type = "NATIVE_NETWORK" as const;
  readonly capabilities = ["chat"] as const;
  readonly trust = "untrusted-distributed" as const;

  /**
   * Which allowlisted model a request maps to. A native id is used as is. `brain/*` aliases pick
   * the first allowlisted model some routable node serves, preferring real models over the mock.
   */
  async resolveModel(requested: string, onlyNode?: string): Promise<string | null> {
    if (isAllowedModel(requested)) return requested;
    const nodes = (await routableNativeNodes()).filter((n) => !onlyNode || n.nodeId === onlyNode);
    const served = new Set(nodes.flatMap((n) => n.reported.capabilities.supportedModels));
    const real = MODEL_ALLOWLIST.find((m) => !m.mock && served.has(m.id));
    if (real) return real.id;
    const mock = MODEL_ALLOWLIST.find((m) => m.mock && served.has(m.id));
    return mock?.id ?? null;
  }

  async estimate(req: ExecutionRequest): Promise<ExecutionEstimate> {
    const notes: string[] = [];
    const base = { provider: this.id, target: this.type, qualityTier: null as number | null };
    const empty = (model: string | null, supported: boolean, available: boolean) => ({ ...base, model, supported, available, availableCapacity: 0, estimatedCost: null, costBasis: null, estimatedLatency: null, latencyBasis: null, confidence: 0, estimatedReliability: 0, notes });
    if (req.kind !== "chat") {
      notes.push("native nodes execute chat models only");
      return empty(null, false, false);
    }
    if (req.tools?.length) {
      notes.push("tool calling is not offered on native nodes yet");
      return empty(null, false, false);
    }
    const model = await this.resolveModel(req.model);
    if (!model) {
      notes.push("no native Brain Node online serves an allowlisted model");
      return empty(null, isAllowedModel(req.model), false);
    }
    if (model === "brain/mock") notes.push("mock model: development nodes only, output is not a language model");
    const r = await routeToNativeNode(model, req.node ? { only: req.node, allowUnmeasured: true } : {});
    if (!r.selected) {
      notes.push(r.reason);
      return empty(model, true, false);
    }
    const eligible = r.ranked.filter((x) => x.eligible).length;
    const nodes = await routableNativeNodes();
    const chosen = nodes.find((n) => n.nodeId === r.selected!.nodeId);
    const tokens = Math.ceil(chatChars(req.messages, req.tools) / 4) + (req.maxTokens ?? 512);
    const cost = priceForTokens(tokens, tokenListPricePer1MUsd());
    if (cost == null) notes.push("UNKNOWN cost: BRAIN_PRICE_USD_PER_1M_TOKENS not configured");
    // Latency from this node's coordinator-timed history only. Unmeasured stays UNKNOWN.
    let latency: number | null = null;
    if (chosen && chosen.measured.tokPerSec.length && chosen.measured.firstByteMs.length) {
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
      latency = Math.round(med(chosen.measured.firstByteMs) + ((req.maxTokens ?? 256) / Math.max(0.1, med(chosen.measured.tokPerSec))) * 1000);
    } else notes.push("UNKNOWN latency: node has no measured jobs yet");
    notes.push(r.reason);
    return {
      ...base,
      model,
      supported: true,
      available: true,
      availableCapacity: Math.min(1, eligible / 4),
      estimatedCost: cost,
      costBasis: cost == null ? null : "list-price",
      estimatedLatency: latency,
      latencyBasis: latency == null ? null : "measured-median",
      confidence: (cost != null ? 0.4 : 0.15) + (latency != null ? 0.4 : 0.1),
      estimatedReliability: chosen ? chosen.reputation / 100 : 0.5,
      notes,
    };
  }

  private async start(req: Extract<ExecutionRequest, { kind: "chat" }>, ctx: ExecutionContext): Promise<InferenceJob> {
    const model = await this.resolveModel(req.model, req.node);
    if (!model) throw new Error(req.node ? `native network: designated node ${req.node} serves no allowlisted model` : "native network: no node serves an allowlisted model");
    const messages: ChatTurn[] = req.messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" }));
    // Consumer cards decode at tens of tokens a second; a request written for an upstream model's
    // 4096-token budget is bounded here so it finishes inside the job deadline.
    const maxTokens = Math.min(req.maxTokens ?? 512, NATIVE_MAX_TOKENS);
    const job = await createInferenceJob({
      requesterId: ctx.customerId,
      model,
      messages,
      maxTokens,
      temperature: req.temperature ?? 0.7,
      ...(req.stop?.length ? { stop: req.stop } : {}),
      orderId: ctx.orderId,
      decisionId: ctx.decisionId,
      ...(req.node ? { pinnedNode: req.node, customerPinned: true } : {}),
      ...(req.privacy ? { privacy: req.privacy } : {}),
      // PRIVATE: the coordinator keeps hashes, not content, once the answer has been delivered.
      ...(req.privacy === "PRIVATE" ? { ephemeral: true } : {}),
    });
    const matched = await matchJob(job.jobId);
    if (matched.state !== "ASSIGNED") {
      const reason = matched.routing?.reason ?? "no capable node";
      await failUnmatched(job.jobId, reason);
      throw new Error(`native network: ${reason}`);
    }
    return matched;
  }

  private async result(job: InferenceJob, t0: number): Promise<ExecutionResult> {
    const ms = Date.now() - t0;
    if (job.state !== "COMPLETED") {
      const error = job.failureReason ?? job.state.toLowerCase();
      void recordSample({ providerId: this.id, at: Date.now(), latencyMs: ms, ok: false, units: 0, error });
      return { ok: false, provider: this.id, target: this.type, jobId: job.jobId, receiptId: job.receiptId ?? "", executionTimeMs: ms, error };
    }
    const receipt = job.receiptId ? await getReceipt(job.receiptId) : null;
    void recordSample({ providerId: this.id, at: Date.now(), latencyMs: ms, ok: true, units: (job.tokenUsage?.prompt ?? 0) + (job.tokenUsage?.completion ?? 0) });
    return {
      ok: true,
      provider: this.id,
      target: this.type,
      model: job.model,
      jobId: job.jobId,
      receiptId: job.receiptId ?? "",
      executionTimeMs: ms,
      content: job.output,
      finishReason: job.finishReason ?? "stop",
      usage: { inputUnits: job.tokenUsage?.prompt ?? 0, outputUnits: job.tokenUsage?.completion ?? 0 },
      cost: receipt?.customerCost ?? null,
      ...(receipt ? { receipt } : {}),
    };
  }

  async execute(req: ExecutionRequest, ctx: ExecutionContext): Promise<ExecutionResult> {
    if (req.kind !== "chat") throw new Error("native network: unsupported request kind");
    const t0 = Date.now();
    const job = await this.start(req, ctx);
    let last = job;
    for await (const { job: j } of observeJob(job.jobId)) last = j;
    const r = await this.result(last, t0);
    if (job.ephemeral) void scrubInferenceJob(job.jobId).catch(() => undefined);
    return r;
  }

  /** OpenAI-shaped SSE built from job progress. The receipt is issued by the coordinator on completion. */
  async executeStream(req: Extract<ExecutionRequest, { kind: "chat" }>, ctx: ExecutionContext) {
    const t0 = Date.now();
    const job = await this.start(req, ctx);
    const id = `chatcmpl-${job.jobId}`;
    const created = Math.floor(t0 / 1000);
    const enc = new TextEncoder();
    const frame = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => frame({ id, object: "chat.completion.chunk", created, model: job.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
    let resolveDone!: (r: ExecutionResult) => void;
    const done = new Promise<ExecutionResult>((r) => (resolveDone = r));
    const self = this;
    const upstream = new ReadableStream<Uint8Array>({
      async start(ctl) {
        ctl.enqueue(chunk({ role: "assistant", content: "" }));
        let last = job;
        try {
          for await (const { job: j, delta } of observeJob(job.jobId)) {
            last = j;
            if (delta) ctl.enqueue(chunk({ content: delta }));
          }
          if (last.state === "COMPLETED") {
            ctl.enqueue(chunk({}, last.finishReason ?? "stop", { usage: { prompt_tokens: last.tokenUsage?.prompt ?? 0, completion_tokens: last.tokenUsage?.completion ?? 0, total_tokens: (last.tokenUsage?.prompt ?? 0) + (last.tokenUsage?.completion ?? 0) } }));
          } else {
            ctl.enqueue(frame({ id, object: "chat.completion.chunk", created, model: job.model, choices: [], error: { code: last.failureReason ?? last.state.toLowerCase(), message: `Brain Node ${last.assignedNode ?? ""} did not complete this request` } }));
          }
          ctl.enqueue(enc.encode("data: [DONE]\n\n"));
          ctl.close();
        } catch (e) {
          ctl.error(e);
        } finally {
          resolveDone(await self.result(last, t0));
          if (job.ephemeral) void scrubInferenceJob(job.jobId).catch(() => undefined);
        }
      },
    });
    return { upstream, done };
  }

  async health(): Promise<ProviderHealth> {
    const nodes = await routableNativeNodes();
    const live = nodes.filter((n) => n.state === "ONLINE" || n.state === "BUSY");
    const st = await providerStats(this.id);
    const mock = live.filter((n) => n.reported.hardware.mock).length;
    const status: ProviderHealth["status"] = live.length === 0 ? "DOWN" : st.reliability != null && st.reliability < 0.8 ? "DEGRADED" : "UP";
    return { provider: this.id, target: this.type, status, detail: live.length === 0 ? "no native Brain Nodes online" : `${live.length} node${live.length === 1 ? "" : "s"} online${mock ? ` (${mock} mock)` : ""} · ${st.samples} measured requests`, checkedAt: Date.now() };
  }
}
