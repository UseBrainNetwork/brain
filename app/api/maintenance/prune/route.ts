import { createHash, timingSafeEqual } from "node:crypto";
import { nodeRoute } from "@/api/http";
import { pruneOldJobs } from "@/services/maintenance";
import { NodeError } from "@/services/nodes";
import { bearer, json } from "@/services/security";

export const dynamic = "force-dynamic";
/** Deleting a day of job rows takes a few minutes in small batches; stop before the route does. */
export const maxDuration = 300;
const WORK_BUDGET_MS = 240_000;

function authorized(req: Request): boolean {
  const given = bearer(req);
  const tokens = [process.env.BRAIN_ADMIN_TOKEN, process.env.CRON_SECRET].filter((t): t is string => Boolean(t));
  if (!given || tokens.length === 0) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return tokens.some((t) => timingSafeEqual(h(t), h(given)));
}

/**
 * Vercel Cron entry point (Authorization: Bearer $CRON_SECRET), hourly. Removes browser kernel
 * job rows older than BRAIN_JOB_RETENTION_HOURS (see services/maintenance). A run that does not
 * clear the backlog in its budget reports `done: false`; the next hour continues.
 */
export const GET = nodeRoute(async (req) => {
  if (!authorized(req)) throw new NodeError("unauthorized", 401);
  const r = await pruneOldJobs({ deadlineMs: WORK_BUDGET_MS });
  console.log(`[prune] removed ${r.deleted} job rows older than ${r.retentionHours}h in ${r.tookMs}ms${r.done ? "" : " (backlog remains)"}`);
  return json(r);
}, 10);
