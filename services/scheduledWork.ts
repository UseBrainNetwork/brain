import type { DistributedJob, WorkloadSize } from "@/domain/types";
import { withTimeout } from "@/lib/async";
import { createJob, jobTtlMs } from "./distributed";
import { getStore } from "./store";

/**
 * Operator-scheduled work: keeps the whole fleet exercised with real, verifiable distributed jobs
 * whenever customer traffic alone would leave it idle. It is labeled as scheduled on the job and
 * the receipt, carries no customer charge, and pays nodes for verified units through the hourly
 * pool exactly like attached or customer work. ZERO verified units still means ZERO reward.
 *
 * Driven by node polls (there is no long-running process on serverless): each poll gives the
 * scheduler a chance to dispatch, subject to the rules below.
 *
 *   BRAIN_SCHEDULED_WORK=off              disable
 *   BRAIN_SCHEDULED_WORK_PER_HOUR=<n>     cap on scheduled jobs per hour (default 40)
 *   BRAIN_SCHEDULED_WORK_GAP_MS=<ms>      minimum gap after the previous scheduled job finished (default 45 s)
 */

const REASON = "network-baseline";
/** A poll checks the store for schedulable work at most this often per instance. */
const CHECK_EVERY_MS = 15_000;

const st = globalThis as typeof globalThis & { __brainSchedAt?: number; __brainScheduling?: boolean };

export function scheduledWorkEnabled() {
  return process.env.BRAIN_SCHEDULED_WORK !== "off";
}
function perHour() {
  const n = Number(process.env.BRAIN_SCHEDULED_WORK_PER_HOUR);
  return n > 0 ? Math.floor(n) : 40;
}
function gapMs() {
  const n = Number(process.env.BRAIN_SCHEDULED_WORK_GAP_MS);
  return n >= 0 ? n : 45_000;
}

/** Sizes rotate so a fleet sees small, medium and large units; weighted toward medium. */
export function pickSize(r = Math.random()): WorkloadSize {
  return r < 0.3 ? "small" : r < 0.85 ? "medium" : "large";
}

const open = (j: DistributedJob, now: number) => j.status !== "completed" && j.status !== "failed" && now - j.createdAt < jobTtlMs(j);

/**
 * Dispatch one scheduled job if none is in flight, the hourly cap is not hit and the gap since
 * the last one has passed. Returns the job or the reason nothing was dispatched.
 */
export async function ensureScheduledWork(now = Date.now(), test?: { dims: { m: number; n: number; k: number }; unitsPerNode: number }): Promise<{ job: DistributedJob | null; reason: string }> {
  if (!scheduledWorkEnabled()) return { job: null, reason: "disabled" };
  if (st.__brainScheduling || now - (st.__brainSchedAt ?? 0) < CHECK_EVERY_MS) return { job: null, reason: "throttled" };
  st.__brainSchedAt = now;
  st.__brainScheduling = true;
  try {
    // Check and dispatch under one cross-instance lock: several serverless instances see the same
    // idle fleet at the same moment and must not each dispatch a job.
    return await getStore().withLock("sched:dispatch", async () => {
      const recent = await withTimeout(getStore().listDistributedJobs(60), 4_000, null);
      if (!recent) return { job: null, reason: "store slow" };
      const mine = recent.filter((j) => j.scheduled);
      if (mine.some((j) => open(j, now))) return { job: null, reason: "in flight" };
      const lastHour = mine.filter((j) => now - j.createdAt < 3_600_000).length;
      if (lastHour >= perHour()) return { job: null, reason: "hourly cap" };
      const last = mine[0];
      const lastDone = last ? (last.completedAt ?? last.createdAt + jobTtlMs(last)) : 0;
      if (now - lastDone < gapMs()) return { job: null, reason: "gap" };
      const job = await createJob({ size: pickSize(), ...test, scheduled: { by: "operator", reason: REASON } });
      return { job, reason: "dispatched" };
    });
  } catch (e) {
    const code = (e as { code?: string }).code ?? (e instanceof Error ? e.message : "error");
    return { job: null, reason: code };
  } finally {
    st.__brainScheduling = false;
  }
}
