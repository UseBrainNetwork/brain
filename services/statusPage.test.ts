import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { DistributedJob, RewardEpoch } from "@/domain/types";
import type { InferenceJob } from "./coordinator/jobs";
import { browserStats, inferenceStats, parseIncidents, settlementStats } from "./statusPage";

const H = 3600_000;

describe("settlementStats", () => {
  it("counts live epochs settled within five minutes of close and reports the slowest", () => {
    const e = (i: number, lateMs: number, provenance: RewardEpoch["provenance"] = "live"): RewardEpoch => ({ id: `E-${i}`, startsAt: i * H, endsAt: (i + 1) * H, settledAt: (i + 1) * H + lateMs, poolLamports: 1, distributedLamports: 1, participants: 10 + i, totalVerifiedCompute: 1, provenance });
    const s = settlementStats([e(3, 30_000), e(2, 12 * 60_000), e(1, 60_000), e(0, 0, "simulated")]);
    expect(s).toEqual({ window: 3, settled: 3, onTime: 2, lateMaxMin: 12, latest: { id: "E-3", participants: 13, settledAfterMin: 1 } });
  });
  it("has nothing to say with no live epochs", () => {
    expect(settlementStats([])).toEqual({ window: 0, settled: 0, onTime: 0, lateMaxMin: null, latest: null });
  });
});

describe("inferenceStats", () => {
  const job = (id: string, model: string, state: InferenceJob["state"], wallMs: number, tokens: number, computeMs: number): InferenceJob =>
    ({ jobId: id, model, state, createdAt: 1_000, completedAt: state === "COMPLETED" ? 1_000 + wallMs : null, computeDurationMs: computeMs, tokenUsage: { prompt: 10, completion: tokens, basis: "node-reported" } }) as unknown as InferenceJob;
  it("groups customer and shadow jobs per model and leaves benchmarks and canaries out", () => {
    const s = inferenceStats([
      job("ij1", "qwen/qwen2.5-1.5b-instruct", "COMPLETED", 2_000, 100, 1_000),
      job("ij2", "qwen/qwen2.5-1.5b-instruct", "COMPLETED", 4_000, 200, 1_000),
      job("vj3", "qwen/qwen2.5-1.5b-instruct", "FAILED", 0, 0, 0),
      job("bj4", "qwen/qwen2.5-1.5b-instruct", "COMPLETED", 1, 1, 1),
      job("cj5", "qwen/qwen2.5-7b-instruct", "COMPLETED", 1, 1, 1),
    ])!;
    expect(s.window).toBe(3);
    expect(s.models).toEqual([{ model: "qwen/qwen2.5-1.5b-instruct", completed: 2, failed: 1, p50Ms: 4_000, p95Ms: 4_000, tokPerSec: 200 }]);
  });
});

describe("browserStats", () => {
  it("measures reassignment latency from the unit that was replaced", () => {
    const j = {
      status: "completed",
      totals: { workUnits: 2, verified: 2, failed: 1, reassigned: 1, computeUnits: 1, nodesUsed: 2, latencyMs: 9_000 },
      units: [
        { id: "1-A", assignedAt: 1_000, status: "lost" },
        { id: "1-A2", assignedAt: 7_500, replacedUnitId: "1-A", status: "verified" },
        { id: "1-B", assignedAt: 1_000, status: "verified" },
      ],
    } as unknown as DistributedJob;
    expect(browserStats([j])).toEqual({ window: 1, jobs: 1, unitsVerified: 2, unitsFailed: 1, reassigned: 1, reassignMedianMs: 6_500, latencyP50Ms: 9_000, latencyP95Ms: 9_000 });
  });
});

describe("parseIncidents", () => {
  it("reads dated headings and the first paragraph, stripping markdown", () => {
    const md = `# Incident log\n\nIntro.\n\n## 2026-10-06 — Database exhausted\n\n**Impact.** The site was down for \`several\` hours. See [docs](https://x).\nSecond line.\n\n**Cause.** Other.\n\n## How incidents are recorded\n\nText.`;
    expect(parseIncidents(md)).toEqual([{ date: "2026-10-06", title: "Database exhausted", summary: "Impact. The site was down for several hours. See docs. Second line." }]);
  });
});
