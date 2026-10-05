import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionEstimate, ExecutionRequest, ExecutionResult, ExecutionTarget, ProviderHealth } from "@/domain/economy";
import { MemoryStore } from "@/services/store";
import { executePlan, getPlan, placeOrder, placeStreamingOrder } from "./orders";
import { compoundPlan, makeStep } from "./plan";
import type { IntelligenceProvider } from "./providers";
import { UpstreamHttpError } from "@/providers/openaiCompatible";

vi.mock("server-only", () => ({}));
// providers.ts pulls in the live node registry; orders tests inject fakes instead.
vi.mock("./providers", () => ({ executionProviders: () => [] }));

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };

type Exec = (req: ExecutionRequest) => Promise<ExecutionResult>;

function fake(id: string, type: ExecutionTarget, est: Partial<ExecutionEstimate>, exec: Exec, stream?: IntelligenceProvider["executeStream"]): IntelligenceProvider {
  return {
    id,
    type,
    capabilities: ["chat"],
    trust: type === "CLOUD_GPU" ? "operator" : type === "EXTERNAL_MODEL" ? "third-party" : "untrusted-distributed",
    async estimate() {
      return { provider: id, target: type, model: "m", supported: true, available: true, estimatedCost: null, costBasis: null, estimatedLatency: null, latencyBasis: null, estimatedReliability: 0.9, availableCapacity: 1, qualityTier: null, confidence: 0.5, notes: [], ...est };
    },
    execute: (req) => exec(req),
    executeStream: stream,
    async health(): Promise<ProviderHealth> {
      return { provider: id, target: type, status: "UP", detail: "", checkedAt: 0 };
    },
  };
}

const ok = (id: string, target: ExecutionTarget, content = "answer", cost: number | null = 0.001): ExecutionResult => ({ ok: true, provider: id, target, jobId: `j-${id}`, receiptId: `r-${id}`, executionTimeMs: 10, content, cost: cost == null ? null : { amount: cost, currency: "USD", basis: "list-price" } });
const chat: ExecutionRequest = { kind: "chat", model: "brain/auto", messages: [{ role: "user", content: "hi" }] };

describe("orders", () => {
  beforeEach(() => {
    g.__brainStore = new MemoryStore();
  });

  it("routes to the selected provider and records a completed order with its receipt and plan", async () => {
    const a = fake("a", "CLOUD_GPU", { estimatedCost: 0.01, estimatedLatency: 500 }, async () => ok("a", "CLOUD_GPU"));
    const b = fake("b", "EXTERNAL_MODEL", { estimatedCost: 0.05, estimatedLatency: 300 }, async () => ok("b", "EXTERNAL_MODEL"));
    const o = await placeOrder({ request: chat, mode: "CHEAP" }, "cust", [a, b]);
    expect(o.status).toBe("COMPLETED");
    expect(o.receiptId).toBe("r-a");
    expect(o.mode).toBe("CHEAP");
    expect(o.privacy).toBe("STANDARD");
    const p = await getPlan(o.planId!);
    expect(p?.shape).toBe("single");
    expect(p?.status).toBe("COMPLETED");
    expect(p?.totalCost?.amount).toBeCloseTo(0.001);
    const fast = await placeOrder({ request: chat, mode: "FAST" }, "cust", [a, b]);
    expect(fast.receiptId).toBe("r-b");
  });

  it("accepts legacy priority/mode aliases", async () => {
    const a = fake("a", "CLOUD_GPU", { estimatedCost: 0.01 }, async () => ok("a", "CLOUD_GPU"));
    expect((await placeOrder({ request: chat, priority: "CHEAP" }, "cust", [a])).mode).toBe("CHEAP");
    expect((await placeOrder({ request: chat, mode: "FASTEST" }, "cust", [a])).mode).toBe("FAST");
    expect((await placeOrder({ request: chat, priority: "BALANCED" }, "cust", [a])).mode).toBe("AUTO");
  });

  it("falls through to the next eligible provider when the selected one fails", async () => {
    const calls: string[] = [];
    const a = fake("a", "CLOUD_GPU", { estimatedCost: 0.01 }, async () => {
      calls.push("a");
      return { ok: false, provider: "a", target: "CLOUD_GPU", jobId: "", receiptId: "", executionTimeMs: 5, error: "upstream 503" };
    });
    const b = fake("b", "EXTERNAL_MODEL", { estimatedCost: 0.05 }, async () => {
      calls.push("b");
      return ok("b", "EXTERNAL_MODEL");
    });
    const o = await placeOrder({ request: chat, mode: "CHEAP" }, "cust", [a, b]);
    expect(calls).toEqual(["a", "b"]);
    expect(o.status).toBe("COMPLETED");
    expect(o.receiptId).toBe("r-b");
  });

  it("rejects when nothing is eligible and explains why", async () => {
    const a = fake("a", "CLOUD_GPU", { available: false, notes: ["not configured"] }, async () => ok("a", "CLOUD_GPU"));
    const o = await placeOrder({ request: chat }, "cust", [a]);
    expect(o.status).toBe("REJECTED");
    expect(o.error).toMatch(/no eligible target/);
  });

  it("fails (not rejects) when every eligible provider errors, with a safe code and no vendor text", async () => {
    const a = fake("a", "CLOUD_GPU", {}, async () => {
      throw new Error("boom: secret vendor body");
    });
    const o = await placeOrder({ request: chat }, "cust", [a]);
    expect(o.status).toBe("FAILED");
    expect(o.error).toBe("unreachable");
  });

  it("surfaces the upstream HTTP status as the error code (402 = provider balance)", async () => {
    const a = fake("a", "CLOUD_GPU", {}, async () => {
      throw new UpstreamHttpError(402, '{"error":"Insufficient credits"}');
    });
    const o = await placeOrder({ request: chat }, "cust", [a]);
    expect(o.status).toBe("FAILED");
    expect(o.error).toBe("upstream 402");
  });

  it("PRIVATE chat never reaches a third-party model, even when it is the only option", async () => {
    const ext = fake("ext", "EXTERNAL_MODEL", { estimatedCost: 0.0001 }, async () => ok("ext", "EXTERNAL_MODEL"));
    const o = await placeOrder({ request: chat, privacy: "PRIVATE" }, "cust", [ext]);
    expect(o.status).toBe("REJECTED");
    expect(o.error).toMatch(/privacy PRIVATE/);
  });

  it("plan total cost is UNKNOWN when any step cost is unknown", async () => {
    const a = fake("a", "CLOUD_GPU", {}, async () => ok("a", "CLOUD_GPU", "x", null));
    const o = await placeOrder({ request: chat }, "cust", [a]);
    expect((await getPlan(o.planId!))?.totalCost).toBeNull();
  });
});

describe("streaming orders", () => {
  beforeEach(() => {
    g.__brainStore = new MemoryStore();
  });
  const sse = (text: string) => new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new TextEncoder().encode(text)), c.close()) });

  it("hands the upstream stream to the caller and resolves the order with a receipt after it ends", async () => {
    const s = fake("s", "CLOUD_GPU", { estimatedCost: 0.01 }, async () => ok("s", "CLOUD_GPU"), async () => ({ upstream: sse("data: {}\n\n"), done: Promise.resolve(ok("s", "CLOUD_GPU", "streamed")) }));
    const { firstByte, done, persisted } = await placeStreamingOrder({ request: chat }, "cust", [s]);
    const fb = await firstByte;
    expect(fb.stream).not.toBeNull();
    expect(fb.provider.id).toBe("s");
    const { order: o } = await done;
    expect(o.status).toBe("COMPLETED");
    expect(o.receiptId).toBe("r-s");
    expect(o.output).toBe("streamed");
    await persisted;
  });

  it("falls back to the next provider when the streaming provider fails before first byte", async () => {
    const bad = fake("bad", "CLOUD_GPU", { estimatedCost: 0.001 }, async () => ok("bad", "CLOUD_GPU"), async () => {
      throw new Error("upstream 503");
    });
    const good = fake("good", "EXTERNAL_MODEL", { estimatedCost: 0.01 }, async () => ok("good", "EXTERNAL_MODEL"));
    const { firstByte, done } = await placeStreamingOrder({ request: chat, mode: "CHEAP" }, "cust", [bad, good]);
    const fb = await firstByte;
    expect(fb.stream).toBeNull(); // non-streaming fallback delivers content in one chunk
    const { order: o } = await done;
    expect(o.status).toBe("COMPLETED");
    expect(o.receiptId).toBe("r-good");
  });
});

describe("compound execution plans", () => {
  beforeEach(() => {
    g.__brainStore = new MemoryStore();
  });
  const c = { mode: "AUTO" as const, privacy: "PUBLIC" as const, maxCost: null, maxLatency: null };
  const req = (content: string): ExecutionRequest => ({ kind: "chat", model: "brain/auto", messages: [{ role: "user", content }] });

  it("runs steps in dependency order, passes upstream output as context, and sums costs", async () => {
    const seen: string[] = [];
    const p = fake("p", "CLOUD_GPU", { estimatedCost: 0.01 }, async (r) => {
      const sys = r.kind === "chat" ? r.messages.find((m) => m.role === "system")?.content ?? "" : "";
      const user = r.kind === "chat" ? r.messages.at(-1)!.content : "";
      seen.push(user + (sys ? `[ctx:${sys.includes("out-a") && sys.includes("out-b") ? "ab" : sys.includes("out-a") ? "a" : "?"}]` : ""));
      return ok("p", "CLOUD_GPU", `out-${user}`, 0.001);
    });
    const a = makeStep("a", "extract", req("a"), c);
    const b = makeStep("b", "extract", req("b"), c);
    const merge = makeStep("m", "synthesise", req("m"), c, [
      { stepId: "a", use: "context" },
      { stepId: "b", use: "context" },
    ]);
    const plan = compoundPlan("o-1", "p-1", [a, b, merge], "m");
    expect(plan.shape).toBe("compound");
    const { final } = await executePlan(plan, { customerId: "cust" }, [p]);
    expect(seen.slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(seen[2]).toBe("m[ctx:ab]");
    expect(final.result?.content).toBe("out-m");
    expect(plan.status).toBe("COMPLETED");
    expect(plan.totalCost?.amount).toBeCloseTo(0.003);
  });

  it("a failed step fails the plan and skips dependents", async () => {
    let n = 0;
    const p = fake("p", "CLOUD_GPU", { estimatedCost: 0.01 }, async () => (n++ === 0 ? { ok: false, provider: "p", target: "CLOUD_GPU", jobId: "", receiptId: "", executionTimeMs: 1, error: "upstream 500" } : ok("p", "CLOUD_GPU")));
    const a = makeStep("a", "extract", req("a"), c);
    const b = makeStep("b", "synthesise", req("b"), c, [{ stepId: "a", use: "context" }]);
    const plan = compoundPlan("o-2", "p-2", [a, b], "b");
    await executePlan(plan, { customerId: "cust" }, [p]);
    expect(plan.status).toBe("FAILED");
    expect(plan.steps[1].status).toBe("SKIPPED");
  });

  it("rejects cyclic or dangling graphs", () => {
    const a = makeStep("a", "x", req("a"), c, [{ stepId: "b", use: "none" }]);
    const b = makeStep("b", "y", req("b"), c, [{ stepId: "a", use: "none" }]);
    expect(() => compoundPlan("o", "p", [a, b], "b")).toThrow(/cycle/);
    expect(() => compoundPlan("o", "p", [makeStep("a", "x", req("a"), c, [{ stepId: "zz", use: "none" }])], "a")).toThrow(/unknown/);
  });
});
