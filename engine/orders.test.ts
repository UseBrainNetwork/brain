import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionEstimate, ExecutionRequest, ExecutionResult, ProviderHealth } from "@/domain/economy";
import { MemoryStore } from "@/services/store";
import { placeOrder } from "./orders";
import type { ExecutionProvider } from "./providers";

vi.mock("server-only", () => ({}));
// providers.ts pulls in the live node registry; orders tests inject fakes instead.
vi.mock("./providers", () => ({ executionProviders: () => [] }));

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };

function fake(id: string, target: ExecutionProvider["target"], est: Partial<ExecutionEstimate>, exec: () => Promise<ExecutionResult>): ExecutionProvider {
  return {
    id,
    target,
    async estimate() {
      return { provider: id, target, estimatedCost: null, costBasis: null, estimatedLatency: null, latencyBasis: null, capacity: 1, modelSupported: true, available: true, confidence: 0.5, reliability: 0.9, notes: [], ...est };
    },
    execute: exec,
    async health(): Promise<ProviderHealth> {
      return { provider: id, target, status: "UP", detail: "", checkedAt: 0 };
    },
  };
}

const ok = (id: string, target: ExecutionProvider["target"]): ExecutionResult => ({ ok: true, provider: id, target, jobId: `j-${id}`, receiptId: `r-${id}`, executionTimeMs: 10 });
const chat: ExecutionRequest = { kind: "chat", model: "brain/auto", messages: [{ role: "user", content: "hi" }] };

describe("orders", () => {
  beforeEach(() => {
    g.__brainStore = new MemoryStore();
  });

  it("routes to the selected provider and records a completed order with its receipt", async () => {
    const a = fake("a", "CLOUD_GPU", { estimatedCost: 0.01, estimatedLatency: 500 }, async () => ok("a", "CLOUD_GPU"));
    const b = fake("b", "EXTERNAL_PROVIDER", { estimatedCost: 0.05, estimatedLatency: 300 }, async () => ok("b", "EXTERNAL_PROVIDER"));
    const o = await placeOrder({ request: chat, priority: "CHEAP" }, "cust", [a, b]);
    expect(o.status).toBe("COMPLETED");
    expect(o.receiptId).toBe("r-a");
    expect(o.mode).toBe("CHEAPEST");
    const fast = await placeOrder({ request: chat, priority: "FAST" }, "cust", [a, b]);
    expect(fast.receiptId).toBe("r-b");
  });

  it("falls through to the next eligible provider when the selected one fails", async () => {
    const calls: string[] = [];
    const a = fake("a", "CLOUD_GPU", { estimatedCost: 0.01 }, async () => {
      calls.push("a");
      return { ok: false, provider: "a", target: "CLOUD_GPU", jobId: "", receiptId: "", executionTimeMs: 5, error: "upstream 503" };
    });
    const b = fake("b", "EXTERNAL_PROVIDER", { estimatedCost: 0.05 }, async () => {
      calls.push("b");
      return ok("b", "EXTERNAL_PROVIDER");
    });
    const o = await placeOrder({ request: chat, priority: "CHEAP" }, "cust", [a, b]);
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

  it("fails (not rejects) when every eligible provider errors", async () => {
    const a = fake("a", "CLOUD_GPU", {}, async () => {
      throw new Error("boom");
    });
    const o = await placeOrder({ request: chat }, "cust", [a]);
    expect(o.status).toBe("FAILED");
    expect(o.error).toBe("provider error");
  });
});
