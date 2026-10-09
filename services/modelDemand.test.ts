import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { demandFromOrders } = await import("./modelDemand");

describe("model demand", () => {
  it("counts only allowlisted native models, splits served / unserved, medians latency", () => {
    const t = 1_000_000;
    const rows = demandFromOrders([
      { model: "qwen/qwen2.5-7b-instruct", status: "COMPLETED", createdAt: t, completedAt: t + 1_000 },
      { model: "qwen/qwen2.5-7b-instruct", status: "COMPLETED", createdAt: t, completedAt: t + 3_000 },
      { model: "qwen/qwen2.5-7b-instruct", status: "REJECTED", createdAt: t },
      { model: "qwen/qwen2.5-72b-instruct-awq", status: "REJECTED", createdAt: t },
      { model: "qwen/qwen2.5-72b-instruct-awq", status: "FAILED", createdAt: t },
      { model: "qwen/qwen2.5-72b-instruct-awq", status: "EXECUTING", createdAt: t },
      { model: "brain/auto", status: "COMPLETED", createdAt: t, completedAt: t + 10 },
      { model: "brain/mock", status: "COMPLETED", createdAt: t, completedAt: t + 10 },
    ]);
    expect(rows).toEqual([
      { model: "qwen/qwen2.5-7b-instruct", asked: 3, served: 2, unserved: 1, p50Ms: 3_000 },
      { model: "qwen/qwen2.5-72b-instruct-awq", asked: 3, served: 0, unserved: 2, p50Ms: null },
    ]);
  });
  it("is empty with no orders", () => {
    expect(demandFromOrders([])).toEqual([]);
  });
});
