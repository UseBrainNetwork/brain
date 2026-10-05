import type { Capability, ExecutionDependency, ExecutionPlan, ExecutionRequest, ExecutionStep, PrivacyRequirement, RequestClassification, RequestConstraints, RoutingMode } from "@/domain/economy";
import { chatChars, wantsTools } from "@/domain/chat";

/**
 * BRAIN AUTO front half: REQUEST → CLASSIFY → PLAN. Pure functions; no I/O, no providers.
 *
 * classify() decides what the request needs. plan() turns it into an ExecutionPlan. Today every
 * request becomes a single-step plan; the primitives (steps, dependencies, context passing) are
 * what compound execution will build on, and executePlan() in engine/orders.ts already walks a
 * dependency graph. Nothing is overbuilt beyond that.
 */

export const defaultPrivacy: PrivacyRequirement = "STANDARD";

export function classify(req: ExecutionRequest): RequestClassification {
  if (req.kind === "compute") {
    return { capability: "compute.matmul_u32", privacy: req.privacy ?? "PUBLIC", size: req.redundancy === 2 ? 2 : 1, needsTools: false, parallelizable: true };
  }
  const promptChars = chatChars(req.messages, req.tools);
  const needsTools = wantsTools(req.tools, req.tool_choice);
  const capability: Capability = needsTools ? "tools" : "chat";
  return {
    capability,
    privacy: req.privacy ?? defaultPrivacy,
    size: Math.ceil(promptChars / 4) + (req.maxTokens ?? 512),
    needsTools,
    parallelizable: false,
  };
}

/**
 * Whether the request body contains plaintext an executing node could read. Verified matmul
 * workloads are seeded synthetic matrices: nothing to leak, so privacy does not restrict them.
 */
export const carriesPlaintext = (req: ExecutionRequest) => req.kind !== "compute";

export interface PlanInput {
  orderId: string;
  request: ExecutionRequest;
  mode: RoutingMode;
  maxCost: number | null;
  maxLatency: number | null;
  privacy?: PrivacyRequirement;
  now?: number;
  newId: (prefix: string) => string;
}

export function makeStep(id: string, label: string, request: ExecutionRequest, constraints: RequestConstraints, dependsOn: ExecutionDependency[] = []): ExecutionStep {
  return { stepId: id, label, request, classification: classify(request), constraints, dependsOn, status: "PENDING" };
}

export function plan(input: PlanInput): ExecutionPlan {
  const now = input.now ?? Date.now();
  const cls = classify(input.request);
  const constraints: RequestConstraints = { mode: input.mode, privacy: input.privacy ?? cls.privacy, maxCost: input.maxCost, maxLatency: input.maxLatency };
  const step = makeStep(input.newId("s"), input.request.kind === "chat" ? "respond" : "compute", input.request, constraints);
  return {
    planId: input.newId("p"),
    orderId: input.orderId,
    createdAt: now,
    shape: "single",
    steps: [step],
    finalStepId: step.stepId,
    status: "PENDING",
    totalCost: null,
    source: "REAL",
  };
}

/** Build a compound plan from explicit steps (used by tests and future planners). Validates the graph. */
export function compoundPlan(orderId: string, planId: string, steps: ExecutionStep[], finalStepId: string, now = Date.now()): ExecutionPlan {
  const ids = new Set(steps.map((s) => s.stepId));
  if (ids.size !== steps.length) throw new Error("plan: duplicate step ids");
  if (!ids.has(finalStepId)) throw new Error("plan: final step not in plan");
  for (const s of steps) for (const d of s.dependsOn) if (!ids.has(d.stepId)) throw new Error(`plan: step ${s.stepId} depends on unknown ${d.stepId}`);
  topologicalOrder(steps); // throws on cycles
  return { planId, orderId, createdAt: now, shape: steps.length > 1 ? "compound" : "single", steps, finalStepId, status: "PENDING", totalCost: null, source: "REAL" };
}

/** Kahn's algorithm. Returns waves of steps that can run concurrently. Throws on a cycle. */
export function topologicalOrder(steps: ExecutionStep[]): ExecutionStep[][] {
  const indeg = new Map(steps.map((s) => [s.stepId, s.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const s of steps) for (const d of s.dependsOn) dependents.set(d.stepId, [...(dependents.get(d.stepId) ?? []), s.stepId]);
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const waves: ExecutionStep[][] = [];
  let ready = steps.filter((s) => s.dependsOn.length === 0);
  let seen = 0;
  while (ready.length) {
    waves.push(ready);
    seen += ready.length;
    const next: ExecutionStep[] = [];
    for (const s of ready) {
      for (const dep of dependents.get(s.stepId) ?? []) {
        const n = (indeg.get(dep) ?? 0) - 1;
        indeg.set(dep, n);
        if (n === 0) next.push(byId.get(dep)!);
      }
    }
    ready = next;
  }
  if (seen !== steps.length) throw new Error("plan: dependency cycle");
  return waves;
}

/** Inject upstream outputs into a chat step as additional context, per its dependencies. */
export function withContext(step: ExecutionStep, outputs: Map<string, string | undefined>): ExecutionRequest {
  if (step.request.kind !== "chat") return step.request;
  const ctxParts = step.dependsOn.filter((d) => d.use === "context").map((d) => outputs.get(d.stepId)).filter((t): t is string => Boolean(t));
  if (!ctxParts.length) return step.request;
  return { ...step.request, messages: [{ role: "system", content: `Context from previous steps:\n\n${ctxParts.join("\n\n---\n\n")}` }, ...step.request.messages] };
}

/** Sum step costs; null if any completed step has UNKNOWN cost. */
export function planTotalCost(plan: ExecutionPlan): ExecutionPlan["totalCost"] {
  let sum = 0;
  for (const s of plan.steps) {
    if (s.status !== "COMPLETED") continue;
    const c = s.result?.cost;
    if (c == null) return null;
    sum += c.amount;
  }
  return { amount: sum, currency: "USD", basis: "list-price" };
}
