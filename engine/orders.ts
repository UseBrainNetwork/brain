import "server-only";
import { randomBytes } from "node:crypto";
import type { ComputeOrder, ExecutionPlan, ExecutionRequest, ExecutionResult, ExecutionStep, LegacyRoutingMode, Priority, PrivacyRequirement, RequestClassification, RouteDecision, RoutingMode, ScoredEstimate } from "@/domain/economy";
import { normalizeMode } from "@/domain/economy";
import { NodeError } from "@/services/nodes";
import { eventBus } from "@/services/eventBus";
import { getStore } from "@/services/store";
import { observeRoute } from "./learning";
import { carriesPlaintext, classify, plan as makePlan, planTotalCost, topologicalOrder, withContext } from "./plan";
import { executionProviders, type IntelligenceProvider } from "./providers";
import { modeWeights, scoreEstimates } from "./router";

/**
 * BRAIN AUTO, end to end:
 *
 *   REQUEST → CLASSIFY → PLAN → ESTIMATE → SELECT → EXECUTE → VERIFY → MERGE → RESPONSE → RECEIPT → LEARN
 *
 * An order is one request with constraints. It becomes an ExecutionPlan (single step today).
 * Each step is routed: every provider estimates, hard constraints filter, the rest are scored,
 * the winner executes and the remaining eligible targets are tried in rank order on failure.
 * Every decision, order, plan and receipt is persisted as REAL.
 */

export interface PlaceOrderInput {
  request: ExecutionRequest;
  /** @deprecated use mode. */
  priority?: Priority;
  mode?: LegacyRoutingMode;
  privacy?: PrivacyRequirement;
  maxCost?: number | null;
  maxLatency?: number | null;
}

const id = (p: string) => `${p}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

async function save(order: ComputeOrder) {
  await getStore().putDoc("order", order.orderId, order, { at: order.createdAt, key: order.customerId });
  eventBus.publish({ type: "order.updated", at: Date.now(), order });
}

async function savePlan(p: ExecutionPlan) {
  await getStore().putDoc("plan", p.planId, p, { at: p.createdAt, key: p.orderId });
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
  const { ranked, selected, reason } = scoreEstimates(estimates, mode, { maxCost: c.maxCost, maxLatency: c.maxLatency, privacy, carriesPlaintext: carriesPlaintext(request) });
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
  await getStore().putDoc("decision", decision.decisionId, decision, { at: decision.at, key: "REAL" });
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

/**
 * Route and execute one step with fallback through the ranked eligible targets.
 * `onSelected` fires before execution so callers (streaming) can act on the chosen provider.
 */
export async function executeStep(step: ExecutionStep, request: ExecutionRequest, ctx: { orderId: string; customerId: string; planId: string }, ps: IntelligenceProvider[], onAttempt?: (p: IntelligenceProvider, decision: RouteDecision) => Promise<ExecutionResult> | undefined): Promise<StepExecution> {
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
  const eligible = decision.estimates.filter((e: ScoredEstimate) => e.eligible);
  let last: ExecutionResult | null = null;
  for (const cand of eligible) {
    const p = ps.find((x) => x.id === cand.provider);
    if (!p) continue;
    try {
      const custom = onAttempt?.(p, decision);
      last = custom ? await custom : await p.execute(request, { orderId: ctx.orderId, decisionId: decision.decisionId, customerId: ctx.customerId, planId: ctx.planId, stepId: step.stepId });
    } catch (e) {
      last = { ok: false, provider: p.id, target: p.type, jobId: "", receiptId: "", executionTimeMs: 0, error: e instanceof NodeError ? e.code : "provider error" };
    }
    attempts.push(last);
    if (last.ok) break;
  }
  step.result = last ?? undefined;
  step.status = last?.ok ? "COMPLETED" : "FAILED";
  step.completedAt = Date.now();
  observeRoute(decision, attempts);
  return { decision, attempts, result: last };
}

/** Walk the plan graph wave by wave; steps in a wave run concurrently. Stops at the first failed wave. */
export async function executePlan(p: ExecutionPlan, ctx: { customerId: string }, ps: IntelligenceProvider[], onAttempt?: Parameters<typeof executeStep>[4]) {
  p.status = "EXECUTING";
  const outputs = new Map<string, string | undefined>();
  const executions = new Map<string, StepExecution>();
  for (const wave of topologicalOrder(p.steps)) {
    const results = await Promise.all(
      wave.map(async (step) => {
        const req = withContext(step, outputs);
        const ex = await executeStep(step, req, { orderId: p.orderId, customerId: ctx.customerId, planId: p.planId }, ps, onAttempt);
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
  await save(order);
  const p = makePlan({ orderId: order.orderId, request: order.request, mode: order.mode, maxCost: order.maxCost, maxLatency: order.maxLatency, privacy: order.privacy, newId: id });
  order.planId = p.planId;
  await savePlan(p);
  order.status = "EXECUTING";
  await save(order);
  const { final, executions } = await executePlan(p, { customerId }, ps);
  await savePlan(p);
  finish(order, p, final, executions.get(final.stepId));
  await save(order);
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
  await save(order);
  const p = makePlan({ orderId: order.orderId, request: order.request, mode: order.mode, maxCost: order.maxCost, maxLatency: order.maxLatency, privacy: order.privacy, newId: id });
  order.planId = p.planId;
  await savePlan(p);
  order.status = "EXECUTING";
  await save(order);

  let resolveStream!: (s: { stream: ReadableStream<Uint8Array> | null; decision: RouteDecision; provider: IntelligenceProvider }) => void;
  const firstByte = new Promise<{ stream: ReadableStream<Uint8Array> | null; decision: RouteDecision; provider: IntelligenceProvider }>((r) => (resolveStream = r));
  let handed = false;

  const run = (async () => {
    const { final, executions } = await executePlan(p, { customerId }, ps, (prov, decision) => {
      if (handed || !prov.executeStream) return undefined;
      const req = input.request;
      return (async () => {
        const { upstream, done } = await prov.executeStream!(req, { orderId: order.orderId, decisionId: decision.decisionId, customerId, planId: p.planId, stepId: p.steps[0].stepId });
        handed = true;
        resolveStream({ stream: upstream, decision, provider: prov });
        return done;
      })();
    });
    await savePlan(p);
    const ex = executions.get(final.stepId);
    finish(order, p, final, ex);
    await save(order);
    if (!handed) resolveStream({ stream: null, decision: ex!.decision, provider: ps.find((x) => x.id === ex?.result?.provider) ?? ps[0] });
    return order;
  })();

  return { order, firstByte, done: run };
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
