import "server-only";
import { randomBytes } from "node:crypto";
import type { ComputeOrder, ExecutionPlan, ExecutionRequest, ExecutionResult, ExecutionStep, LegacyRoutingMode, Priority, PrivacyRequirement, RequestClassification, RouteDecision, RoutingMode, ScoredEstimate } from "@/domain/economy";
import { normalizeMode, ComputeReceipt } from "@/domain/economy";
import { NodeError } from "@/services/nodes";
import { eventBus } from "@/services/eventBus";
import { getStore } from "@/services/store";
import { observeRoute } from "./learning";
import { carriesPlaintext, classify, plan as makePlan, planTotalCost, topologicalOrder, withContext } from "./plan";
import { logProviderError, safeProviderError } from "./errors";
import { background } from "@/lib/async";
import { executionProviders, type IntelligenceProvider } from "./providers";
import { backoffMs, DEFAULT_BUDGET_MS, DEFAULT_POLICY, isRetryable, noteAttempt, orderByHealth, type AttemptRecord, type GatewayPolicy } from "./policy";
import { modeWeights, scoreEstimates } from "./router";

/**
 * BRAIN AUTO, end to end:
 *
 *   REQUEST → CLASSIFY → PLAN → ESTIMATE → SELECT → EXECUTE → VERIFY → MERGE → RESPONSE → RECEIPT → LEARN
 *
 * An order is one request with constraints. It becomes an ExecutionPlan (single step today).
 * Each step is routed: every provider estimates, hard constraints filter, the rest are scored,
 * the winner executes; transient failures are retried on the same provider and then the remaining
 * eligible targets are tried in rank order (see ./policy). Every decision, order, plan, receipt
 * and attempt is persisted as REAL.
 */

export interface PlaceOrderInput {
  request: ExecutionRequest;
  /** @deprecated use mode. */
  priority?: Priority;
  mode?: LegacyRoutingMode;
  privacy?: PrivacyRequirement;
  maxCost?: number | null;
  maxLatency?: number | null;
  /** Retry / fallback / budget. Defaults to DEFAULT_POLICY. */
  policy?: GatewayPolicy;
}

const id = (p: string) => `${p}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

/**
 * PRIVATE orders are stored without their content: the prompt is replaced by its message count,
 * the output and tool calls are dropped. Routing facts, receipt and attempts stay. The in-memory
 * order the caller holds is untouched, so the answer still reaches the customer.
 */
function storable(order: ComputeOrder): ComputeOrder {
  if (order.privacy !== "PRIVATE") return order;
  const { output: _o, toolCalls: _t, ...rest } = order;
  void _o;
  void _t;
  const request: ExecutionRequest = order.request.kind === "chat" ? { ...order.request, messages: [], tools: undefined, contentRedacted: true, messageCount: order.request.messages.length } as ExecutionRequest : order.request;
  return { ...rest, request, contentRetained: false };
}

function storablePlan(p: ExecutionPlan, order: ComputeOrder): ExecutionPlan {
  if (order.privacy !== "PRIVATE") return p;
  return {
    ...p,
    steps: p.steps.map((s) => ({
      ...s,
      request: s.request.kind === "chat" ? ({ ...s.request, messages: [], tools: undefined, contentRedacted: true, messageCount: s.request.messages.length } as ExecutionRequest) : s.request,
      result: s.result ? { ...s.result, content: undefined, toolCalls: undefined, receipt: undefined } : s.result,
    })),
  };
}

async function save(order: ComputeOrder) {
  const doc = storable(order);
  await getStore().putDoc("order", order.orderId, doc, { at: order.createdAt, key: order.customerId });
  eventBus.publish({ type: "order.updated", at: Date.now(), order: doc });
}

async function savePlan(p: ExecutionPlan, order?: ComputeOrder) {
  await getStore().putDoc("plan", p.planId, order ? storablePlan(p, order) : p, { at: p.createdAt, key: p.orderId });
}

export interface DecideConstraints {
  maxCost?: number | null;
  maxLatency?: number | null;
  privacy?: PrivacyRequirement;
}

/** ESTIMATE + SELECT for one request. Persists the decision. */
export async function decide(request: ExecutionRequest, mode: RoutingMode, c: DecideConstraints, ps: IntelligenceProvider[] = executionProviders(), cls: RequestClassification = classify(request)): Promise<RouteDecision> {
  const estimates = await Promise.all(ps.map((p) => p.estimate(request)));
  const privacy = c.privacy ?? cls.privacy;
  const designatedNode = request.kind === "chat" ? request.node : undefined;
  const { ranked, selected, reason } = scoreEstimates(estimates, mode, { maxCost: c.maxCost, maxLatency: c.maxLatency, privacy, carriesPlaintext: carriesPlaintext(request), designatedNode });
  const decision: RouteDecision = {
    decisionId: id("d"),
    at: Date.now(),
    mode,
    privacy,
    weights: modeWeights[mode],
    request: { kind: request.kind, model: request.kind === "chat" ? request.model : "brain/matmul-u32", capability: cls.capability },
    estimates: ranked,
    selected: selected ? { provider: selected.provider, target: selected.target } : null,
    reason,
    source: "REAL",
  };
  // Persisted off the hot path: a slow store must not delay the first token.
  void background("decision", getStore().putDoc("decision", decision.decisionId, decision, { at: decision.at, key: "REAL" }));
  return decision;
}

const legacyPriority = (mode: RoutingMode): Priority => (mode === "CHEAP" ? "CHEAP" : mode === "FAST" ? "FAST" : mode === "QUALITY" ? "QUALITY" : "BALANCED");

function newOrder(input: PlaceOrderInput, customerId: string): ComputeOrder {
  const mode = normalizeMode(input.mode ?? (input.priority === "CHEAP" ? "CHEAP" : input.priority === "FAST" ? "FAST" : input.priority === "QUALITY" ? "QUALITY" : "AUTO"));
  const req = input.request;
  return {
    orderId: id("o"),
    customerId,
    workload: req.kind === "chat" ? "chat" : "matmul_u32",
    model: req.kind === "chat" ? req.model : "brain/matmul-u32",
    request: req,
    maxCost: input.maxCost ?? null,
    maxLatency: input.maxLatency ?? null,
    priority: legacyPriority(mode),
    mode,
    privacy: input.privacy ?? classify(req).privacy,
    policy: input.policy ?? DEFAULT_POLICY,
    createdAt: Date.now(),
    status: "ROUTING",
    source: "REAL",
  };
}

export interface StepExecution {
  decision: RouteDecision;
  attempts: ExecutionResult[];
  result: ExecutionResult | null;
}

export interface StepContext {
  orderId: string;
  customerId: string;
  planId: string;
  policy?: GatewayPolicy;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Route and execute one step. Providers are tried in rank order (cooling ones last); each gets
 * `1 + policy.retries` tries while its failure is transient and the budget allows; `fallback: false`
 * stops after the first provider. `onAttempt` lets the streaming caller run the attempt itself.
 */
export async function executeStep(step: ExecutionStep, request: ExecutionRequest, ctx: StepContext, ps: IntelligenceProvider[], onAttempt?: (p: IntelligenceProvider, decision: RouteDecision) => Promise<ExecutionResult> | undefined): Promise<StepExecution> {
  step.status = "ROUTING";
  step.startedAt = Date.now();
  const decision = await decide(request, step.constraints.mode, { maxCost: step.constraints.maxCost, maxLatency: step.constraints.maxLatency, privacy: step.constraints.privacy }, ps, step.classification);
  step.decisionId = decision.decisionId;
  const attempts: ExecutionResult[] = [];
  if (!decision.selected) {
    step.status = "FAILED";
    step.completedAt = Date.now();
    return { decision, attempts, result: null };
  }
  step.status = "EXECUTING";
  const policy = ctx.policy ?? DEFAULT_POLICY;
  const budgetMs = policy.timeoutMs ?? step.constraints.maxLatency ?? DEFAULT_BUDGET_MS;
  const deadline = step.startedAt + budgetMs;
  const eligible = orderByHealth(decision.estimates.filter((e: ScoredEstimate) => e.eligible));
  const log: AttemptRecord[] = [];
  let last: ExecutionResult | null = null;
  let stop: string | undefined;
  providers: for (const cand of eligible) {
    const p = ps.find((x) => x.id === cand.provider);
    if (!p) continue;
    for (let retry = 0; retry <= policy.retries; retry++) {
      if (retry > 0) {
        const wait = backoffMs(retry - 1);
        if (Date.now() + wait > deadline) {
          stop = "budget exhausted";
          break providers;
        }
        await sleep(wait);
      }
      const t0 = Date.now();
      try {
        const custom = onAttempt?.(p, decision);
        last = custom ? await custom : await p.execute(request, { orderId: ctx.orderId, decisionId: decision.decisionId, customerId: ctx.customerId, planId: ctx.planId, stepId: step.stepId, mode: step.constraints.mode });
      } catch (e) {
        logProviderError(p.id, e);
        last = { ok: false, provider: p.id, target: p.type, jobId: "", receiptId: "", executionTimeMs: Date.now() - t0, error: e instanceof NodeError ? e.code : safeProviderError(e) };
      }
      attempts.push(last);
      log.push({ provider: p.id, target: p.type, retry, ok: last.ok, error: last.ok ? undefined : last.error, ms: last.executionTimeMs || Date.now() - t0, at: t0 });
      noteAttempt(p.id, last.ok, last.error);
      if (last.ok) break providers;
      // A stream that already reached the customer cannot be retried or re-routed.
      if (last.error?.startsWith("stream_interrupted")) {
        stop = "stream already started";
        break providers;
      }
      if (!isRetryable(last.error)) break;
      if (Date.now() >= deadline) {
        stop = "budget exhausted";
        break providers;
      }
    }
    if (!policy.fallback) {
      stop = "fallback disabled";
      break;
    }
  }
  step.attempts = log;
  if (stop) step.stopReason = stop;
  step.result = last ?? undefined;
  step.status = last?.ok ? "COMPLETED" : "FAILED";
  step.completedAt = Date.now();
  observeRoute(decision, attempts);
  return { decision, attempts, result: last };
}

/** Walk the plan graph wave by wave; steps in a wave run concurrently. Stops at the first failed wave. */
export async function executePlan(p: ExecutionPlan, ctx: { customerId: string; policy?: GatewayPolicy }, ps: IntelligenceProvider[], onAttempt?: Parameters<typeof executeStep>[4]) {
  p.status = "EXECUTING";
  const outputs = new Map<string, string | undefined>();
  const executions = new Map<string, StepExecution>();
  for (const wave of topologicalOrder(p.steps)) {
    const results = await Promise.all(
      wave.map(async (step) => {
        const req = withContext(step, outputs);
        const ex = await executeStep(step, req, { orderId: p.orderId, customerId: ctx.customerId, planId: p.planId, policy: ctx.policy }, ps, onAttempt);
        executions.set(step.stepId, ex);
        if (ex.result?.ok) outputs.set(step.stepId, ex.result.content);
        return ex;
      }),
    );
    if (results.some((r) => !r.result?.ok)) {
      for (const s of p.steps) if (s.status === "PENDING") s.status = "SKIPPED";
      break;
    }
  }
  const final = p.steps.find((s) => s.stepId === p.finalStepId)!;
  p.status = final.status === "COMPLETED" ? "COMPLETED" : "FAILED";
  p.completedAt = Date.now();
  p.totalCost = planTotalCost(p);
  p.totalLatencyMs = p.completedAt - p.createdAt;
  return { final, executions };
}

function finish(order: ComputeOrder, p: ExecutionPlan, final: ExecutionStep, ex: StepExecution | undefined) {
  order.completedAt = Date.now();
  order.planId = p.planId;
  order.decisionId = final.decisionId ?? ex?.decision.decisionId;
  // Every attempt across the plan, in order, so the customer sees retries and fallbacks as facts.
  order.attempts = p.steps.flatMap((s) => s.attempts ?? []);
  // Keep the receipt of a genuinely failed browser job on the order so the failure is auditable.
  const anyReceipt = ex?.attempts.find((a) => a.receiptId);
  if (anyReceipt) {
    order.receiptId = anyReceipt.receiptId;
    order.jobId = anyReceipt.jobId;
  }
  if (final.status === "COMPLETED" && ex?.result?.ok) {
    order.status = "COMPLETED";
    order.jobId = ex.result.jobId;
    order.receiptId = ex.result.receiptId;
    order.output = ex.result.content;
    order.toolCalls = ex.result.toolCalls;
    order.finishReason = ex.result.finishReason;
  } else if (ex && !ex.decision.selected) {
    order.status = "REJECTED";
    order.error = ex.decision.reason;
  } else {
    order.status = "FAILED";
    order.error = ex?.result?.error ?? "no provider executed";
  }
}

/** Places and executes an order. Resolves when the order is terminal. */
export async function placeOrder(input: PlaceOrderInput, customerId: string, ps: IntelligenceProvider[] = executionProviders()): Promise<ComputeOrder> {
  const order = newOrder(input, customerId);
  const p = makePlan({ orderId: order.orderId, request: order.request, mode: order.mode, maxCost: order.maxCost, maxLatency: order.maxLatency, privacy: order.privacy, newId: id });
  order.planId = p.planId;
  order.status = "EXECUTING";
  const pending = [background("order.create", save(order)), background("plan.create", savePlan(p, order))];
  try {
    const { final, executions } = await executePlan(p, { customerId, policy: order.policy }, ps);
    finish(order, p, final, executions.get(final.stepId));
  } catch (e) {
    console.error("[orders] order failed", order.orderId, e instanceof Error ? `${e.name}: ${e.message}` : e);
    order.status = "FAILED";
    order.error = "internal";
    order.completedAt = Date.now();
  }
  await Promise.allSettled(pending);
  await Promise.all([savePlan(p, order), save(order)]);
  return order;
}

/**
 * Streaming variant for chat. Routes like placeOrder, but when the chosen provider supports
 * executeStream the caller receives the upstream byte stream immediately; `done` resolves to the
 * terminal order (with receipt) once the stream ends. Providers without streaming are executed
 * normally and their content is delivered as a single chunk by the caller.
 */
export async function placeStreamingOrder(input: PlaceOrderInput & { request: Extract<ExecutionRequest, { kind: "chat" }> }, customerId: string, ps: IntelligenceProvider[] = executionProviders()) {
  const order = newOrder(input, customerId);
  const p = makePlan({ orderId: order.orderId, request: order.request, mode: order.mode, maxCost: order.maxCost, maxLatency: order.maxLatency, privacy: order.privacy, newId: id });
  order.planId = p.planId;
  order.status = "EXECUTING";
  // Initial bookkeeping runs concurrently with routing and the upstream call. Terminal state is
  // written after, in order, so a reader never sees a stale status outlive the run.
  const pending: Promise<unknown>[] = [background("order.create", save(order)), background("plan.create", savePlan(p, order))];

  let resolveStream!: (s: { stream: ReadableStream<Uint8Array> | null; decision: RouteDecision; provider: IntelligenceProvider }) => void;
  const firstByte = new Promise<{ stream: ReadableStream<Uint8Array> | null; decision: RouteDecision; provider: IntelligenceProvider }>((r) => (resolveStream = r));
  let handed = false;
  // `done` resolves the moment the order reaches a terminal state in memory; `persisted` once the
  // terminal state has been written. The stream answers off `done` and waits for `persisted` after.
  let resolveDone!: (o: { order: ComputeOrder; receipt: ComputeReceipt | null }) => void;
  const done = new Promise<{ order: ComputeOrder; receipt: ComputeReceipt | null }>((r) => (resolveDone = r));

  const persisted = (async () => {
    try {
      const { final, executions } = await executePlan(p, { customerId, policy: order.policy }, ps, (prov, decision) => {
        if (handed || !prov.executeStream) return undefined;
        const req = input.request;
        return (async (): Promise<ExecutionResult> => {
          const { upstream, done } = await prov.executeStream!(req, { orderId: order.orderId, decisionId: decision.decisionId, customerId, planId: p.planId, stepId: p.steps[0].stepId, mode: p.steps[0].constraints.mode });
          handed = true;
          resolveStream({ stream: upstream, decision, provider: prov });
          // Bytes have reached the customer. A failure from here is reported, not retried or re-routed.
          return done.then((r) => (r.ok ? r : { ...r, error: `stream_interrupted: ${r.error ?? "unknown"}` }));
        })();
      });
      const ex = executions.get(final.stepId);
      finish(order, p, final, ex);
      if (!handed) resolveStream({ stream: null, decision: ex!.decision, provider: ps.find((x) => x.id === ex?.result?.provider) ?? ps[0] });
      resolveDone({ order, receipt: ex?.result?.receipt ?? null });
      await Promise.allSettled(pending);
      await Promise.all([savePlan(p, order), save(order)]);
      return order;
    } catch (e) {
      // Never leave an order parked in ROUTING/EXECUTING because a store write or planner call threw.
      console.error("[orders] streaming order failed", order.orderId, e instanceof Error ? `${e.name}: ${e.message}` : e);
      order.status = "FAILED";
      order.error = "internal";
      order.completedAt = Date.now();
      if (!handed) resolveStream({ stream: null, decision: { decisionId: "", estimates: [], selected: null, reason: "internal error" } as unknown as RouteDecision, provider: ps[0] });
      resolveDone({ order, receipt: null });
      await Promise.allSettled(pending);
      await save(order).catch(() => {});
      return order;
    }
  })();

  return { order, firstByte, done, persisted };
}

/**
 * Public view of an order: routing facts only. Prompts and outputs belong to the customer and
 * never leave the server through list/detail endpoints or the event stream.
 */
export function publicOrder(o: ComputeOrder): Omit<ComputeOrder, "request" | "output"> & { request: { kind: ExecutionRequest["kind"]; model: string; messageCount?: number; size?: string }; hasOutput: boolean } {
  const { request, output, ...rest } = o;
  const pub = request.kind === "chat" ? { kind: "chat" as const, model: request.model, messageCount: request.messages.length } : { kind: "compute" as const, model: "brain/matmul-u32", size: request.size };
  return { ...rest, request: pub, hasOutput: Boolean(output) };
}

export async function getOrder(orderId: string) {
  return getStore().getDoc<ComputeOrder>("order", orderId);
}

export async function listOrders(limit = 20, customerId?: string) {
  return getStore().listDocs<ComputeOrder>("order", { limit, key: customerId });
}

export async function getDecision(decisionId: string) {
  return getStore().getDoc<RouteDecision>("decision", decisionId);
}

export async function listDecisions(limit = 20) {
  return getStore().listDocs<RouteDecision>("decision", { limit, key: "REAL" });
}

export async function getPlan(planId: string) {
  return getStore().getDoc<ExecutionPlan>("plan", planId);
}
