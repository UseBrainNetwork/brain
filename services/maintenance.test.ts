import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { DEFAULT_RETENTION_HOURS, jobRetentionMs, pruneOldJobs } from "./maintenance";
import { MemoryStore, type StoredJob } from "./store";

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };
const H = 3600_000;

function job(id: string, at: number, extra: Partial<StoredJob> & { source?: string } = {}): StoredJob {
  return {
    id,
    model: "tensor/matmul-u32",
    kind: "tensor",
    status: "completed",
    nodeIds: ["n1"],
    workUnits: 1,
    computeUnits: 10,
    submittedAt: at,
    lifecycle: [],
    provenance: "live",
    spec: { kernel: "matmul_u32", m: 8, n: 8, k: 8, seedA: 1, seedB: 2 },
    assignedTo: "n1",
    issuedAt: at,
    deadline: at + 30_000,
    canary: false,
    sampleIndices: [],
    verified: true,
    ...extra,
  } as StoredJob;
}

describe("job retention", () => {
  const env = { ...process.env };
  beforeEach(() => {
    g.__brainStore = new MemoryStore();
    delete process.env.BRAIN_JOB_RETENTION_HOURS;
    delete process.env.BRAIN_EPOCH_MINUTES;
  });
  afterEach(() => {
    process.env = { ...env };
    g.__brainStore = undefined;
  });

  it("defaults to 48 h and honours BRAIN_JOB_RETENTION_HOURS", () => {
    process.env.BRAIN_EPOCH_MINUTES = "60";
    expect(jobRetentionMs()).toBe(DEFAULT_RETENTION_HOURS * H);
    process.env.BRAIN_JOB_RETENTION_HOURS = "24";
    expect(jobRetentionMs()).toBe(24 * H);
  });

  it("never keeps less than two epochs or six hours, whatever the env says", () => {
    process.env.BRAIN_EPOCH_MINUTES = "60";
    process.env.BRAIN_JOB_RETENTION_HOURS = "1";
    expect(jobRetentionMs()).toBe(6 * H);
    // Daily epochs: a 24 h setting would delete the epoch settlement is about to read.
    process.env.BRAIN_EPOCH_MINUTES = String(24 * 60);
    process.env.BRAIN_JOB_RETENTION_HOURS = "24";
    expect(jobRetentionMs()).toBe(48 * H);
  });

  it("removes old browser jobs, keeps recent ones and every native work record", async () => {
    process.env.BRAIN_EPOCH_MINUTES = "60";
    process.env.BRAIN_JOB_RETENTION_HOURS = "24";
    const now = Date.now();
    const s = g.__brainStore!;
    await s.saveJobs([
      job("old-1", now - 30 * H),
      job("old-2", now - 25 * H),
      job("fresh", now - 23 * H),
      job("native-old", now - 72 * H, { source: "native-inference" }),
    ]);
    const r = await pruneOldJobs();
    expect(r.deleted).toBe(2);
    expect(r.done).toBe(true);
    expect(r.retentionHours).toBe(24);
    expect(await s.getJob("old-1")).toBeNull();
    expect(await s.getJob("old-2")).toBeNull();
    expect(await s.getJob("fresh")).not.toBeNull();
    expect(await s.getJob("native-old")).not.toBeNull();
  });
});
