import { epochLengthMs } from "./settlement";
import { getStore } from "./store";

/**
 * Housekeeping that keeps the store a bounded size. Browser kernel jobs are the bulk of brain_jobs:
 * every node that takes synthetic work writes a row every few seconds, so the table grows by
 * millions of rows a day and must be trimmed on a schedule. Nothing here touches settled epochs,
 * allocations or claims; only the raw job rows older than the retention window go.
 */

export const DEFAULT_RETENTION_HOURS = 48;
const MIN_RETENTION_HOURS = 6;

/**
 * How long job rows are kept. BRAIN_JOB_RETENTION_HOURS, default 48, never below 6 h and never
 * below two epochs: settlement reads the last closed epoch from brain_jobs, and a late or retried
 * settlement must still find it.
 */
export function jobRetentionMs(): number {
  const h = Number(process.env.BRAIN_JOB_RETENTION_HOURS);
  const hours = Math.max(h > 0 ? h : DEFAULT_RETENTION_HOURS, MIN_RETENTION_HOURS);
  return Math.max(hours * 3600_000, 2 * epochLengthMs());
}

export async function pruneOldJobs(opts: { batch?: number; deadlineMs?: number } = {}) {
  const retentionMs = jobRetentionMs();
  const cutoff = Date.now() - retentionMs;
  const t0 = Date.now();
  const r = await getStore().pruneJobs(cutoff, opts);
  return { ...r, cutoff, retentionHours: retentionMs / 3600_000, tookMs: Date.now() - t0 };
}
