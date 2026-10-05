import "server-only";
import { randomBytes } from "node:crypto";
import type { ComputeOrder, ExecutionRequest, ExecutionResult, Priority, RouteDecision, RoutingMode, ScoredEstimate } from "@/domain/economy";
import { NodeError } from "@/services/nodes";
import { eventBus } from "@/services/eventBus";
import { getStore } from "@/services/store";
import { executionProviders, type ExecutionProvider } from "./providers";
import { modeWeights, priorityMode, scoreEstimates } from "./router";

/**
 * Compute market, deliberately simple: an order is one request with constraints. BRAIN AUTO
 * estimates every execution target, picks one, executes, and falls through to the next eligible
 * target if the first fails. Every step is recorded (decision, order, receipt).
 */

export interface PlaceOrderInput {
  request: ExecutionRequest;
  priority?: Priority;
  mode?: RoutingMode;
  maxCost?: number | null;
  maxLatency?: number | null;
}

const id = (p: string) => `${p}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

async function save(order: ComputeOrder) {
  await getStore().putDoc("order", order.orderId, order, { at: order.createdAt, key: order.customerId });
  eventBus.publish({ type: "order.updated", at: Date.now(), order });
}

export async function decide(request: ExecutionRequest, mode: RoutingMode, c: { maxCost?: number | null; maxLatency?: number | null }, ps: ExecutionProvider[] = executionProviders()): Promise<RouteDecision> {
  const estimates = await Promise.all(ps.map((p) => p.estimate(request)));
  const { ranked, selected, reason } = scoreEstimates(estimates, mode, c);
  const decision: RouteDecision = {
    decisionId: id("d"),
    at: Date.now(),
    mode,
    weights: modeWeights[mode],
    request: { kind: request.kind, model: request.kind === "chat" ? request.model : "brain/matmul-u32" },
    estimates: ranked,
    selected: selected ? { provider: selected.provider, target: selected.target } : null,
    reason,
    source: "REAL",
  };
  await getStore().putDoc("decision", decision.decisionId, decision, { at: decision.at, key: "REAL" });
  return decision;
}

/** Places and executes an order. Resolves when the order is terminal. */
export async function placeOrder(input: PlaceOrderInput, customerId: string, ps: ExecutionProvider[] = executionProviders()): Promise<ComputeOrder> {
  const priority = input.priority ?? "BALANCED";
  const mode = input.mode ?? priorityMode[priority];
  const req = input.request;
  const order: ComputeOrder = {
    orderId: id("o"),
    customerId,
    workload: req.kind === "chat" ? "chat" : "matmul_u32",
    model: req.kind === "chat" ? req.model : "brain/matmul-u32",
    request: req,
    maxCost: input.maxCost ?? null,
    maxLatency: input.maxLatency ?? null,
    priority,
    mode,
    createdAt: Date.now(),
    status: "ROUTING",
    source: "REAL",
  };
  await save(order);

  const decision = await decide(req, mode, { maxCost: order.maxCost, maxLatency: order.maxLatency }, ps);
  order.decisionId = decision.decisionId;
  if (!decision.selected) {
    order.status = "REJECTED";
    order.error = decision.reason;
    order.completedAt = Date.now();
    await save(order);
    return order;
  }
  order.status = "EXECUTING";
  await save(order);

  // Try the selected target, then fall through the remaining eligible ones in rank order.
  const eligible = decision.estimates.filter((e: ScoredEstimate) => e.eligible);
  let last: ExecutionResult | null = null;
  for (const cand of eligible) {
    const p = ps.find((x) => x.id === cand.provider);
    if (!p) continue;
    try {
      last = await p.execute(req, { orderId: order.orderId, decisionId: decision.decisionId, customerId });
    } catch (e) {
      last = { ok: false, provider: p.id, target: p.target, jobId: "", receiptId: "", executionTimeMs: 0, error: e instanceof NodeError ? e.code : "provider error" };
    }
    if (last.ok) break;
    // A browser-network job that genuinely failed still has a receipt; keep it on the order.
    if (last.receiptId) order.receiptId = last.receiptId;
    if (last.jobId) order.jobId = last.jobId;
  }
  order.completedAt = Date.now();
  if (last?.ok) {
    order.status = "COMPLETED";
    order.jobId = last.jobId;
    order.receiptId = last.receiptId;
    order.output = last.content;
  } else {
    order.status = "FAILED";
    order.error = last?.error ?? "no provider executed";
  }
  await save(order);
  return order;
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
