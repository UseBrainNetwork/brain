import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DistributedJob, RewardEpoch } from "@/domain/types";
import { withTimeout } from "@/lib/async";
import { listInferenceJobs, type InferenceJob } from "./coordinator/jobs";
import { listJobs } from "./distributed";
import { lastKnownGood } from "./failsoft";
import { PgStore } from "./pgStore";
import { getStore } from "./store";

/**
 * Everything on /status, measured by this server from its own records. No external monitor, no
 * uptime percentage we did not compute, no section that is estimated when its source is down: a
 * section whose read fails is reported as unavailable.
 *
 *   database     a timed read on the store and which pooler lanes are open
 *   settlement   the last 48 hourly epochs: how many settled, how late, and the latest one
 *   inference    native node jobs in the recent window, per model: p50/p95 wall time, tokens/s, fail rate
 *   browser      recent distributed jobs: verified share, reassignments, reassign latency
 *   incidents    the hand-written incident log (gitbook/trust/incident-log.md)
 */

export interface StatusData {
  asOf: number;
  database: { ok: boolean; pingMs: number | null; lanes: { name: string; mode: string; coolingDownSec: number }[] | null } | null;
  settlement: { window: number; settled: number; onTime: number; lateMaxMin: number | null; latest: { id: string; participants: number; settledAfterMin: number } | null } | null;
  inference: { window: number; sinceMs: number | null; models: InferenceModelStats[] } | null;
  browser: { window: number; jobs: number; unitsVerified: number; unitsFailed: number; reassigned: number; reassignMedianMs: number | null; latencyP50Ms: number | null; latencyP95Ms: number | null } | null;
  incidents: Incident[];
}

export interface InferenceModelStats {
  model: string;
  completed: number;
  failed: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Median completion tokens per second of coordinator-timed compute. Tokens are node-reported. */
  tokPerSec: number | null;
}

export interface Incident {
  /** Heading text, e.g. "2026-10-07 — Settlement contention, then pooler failure". */
  title: string;
  date: string;
  /** First paragraph after the heading, plain text. */
  summary: string;
}

const ON_TIME_MS = 5 * 60_000;
const SECTION_MS = 6_000;

const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function database(): Promise<StatusData["database"]> {
  const store = getStore();
  const t0 = Date.now();
  try {
    await withTimeout(store.getDoc("meta", "schema"), SECTION_MS, null);
    const pingMs = Date.now() - t0;
    return { ok: true, pingMs, lanes: store instanceof PgStore ? store.laneStatus() : null };
  } catch {
    return { ok: false, pingMs: null, lanes: store instanceof PgStore ? store.laneStatus() : null };
  }
}

export function settlementStats(epochs: RewardEpoch[]): StatusData["settlement"] {
  const live = epochs.filter((e) => e.provenance === "live");
  const delays = live.map((e) => e.settledAt - e.endsAt);
  const latest = live[0] ?? null;
  return {
    window: live.length,
    settled: live.length,
    onTime: delays.filter((d) => d <= ON_TIME_MS).length,
    lateMaxMin: delays.length ? Math.round(Math.max(...delays) / 60_000) : null,
    latest: latest ? { id: latest.id, participants: latest.participants, settledAfterMin: Math.round((latest.settledAt - latest.endsAt) / 60_000) } : null,
  };
}

export function inferenceStats(jobs: InferenceJob[]): StatusData["inference"] {
  // Customer and shadow jobs only; benchmarks and canaries are scheduling, not service.
  const service = jobs.filter((j) => j.jobId.startsWith("ij") || j.jobId.startsWith("vj"));
  const byModel = new Map<string, InferenceJob[]>();
  for (const j of service) byModel.set(j.model, [...(byModel.get(j.model) ?? []), j]);
  const models: InferenceModelStats[] = [...byModel.entries()]
    .map(([model, js]) => {
      const done = js.filter((j) => j.state === "COMPLETED");
      const wall = done.map((j) => (j.completedAt ?? 0) - j.createdAt).filter((x) => x > 0);
      const tps = done.map((j) => (j.tokenUsage && j.computeDurationMs ? (j.tokenUsage.completion * 1000) / j.computeDurationMs : null)).filter((x): x is number => x != null && Number.isFinite(x) && x > 0);
      return { model, completed: done.length, failed: js.filter((j) => j.state === "FAILED").length, p50Ms: pct(wall, 50), p95Ms: pct(wall, 95), tokPerSec: pct(tps, 50) };
    })
    .sort((a, b) => b.completed - a.completed);
  return { window: service.length, sinceMs: service.length ? Math.min(...service.map((j) => j.createdAt)) : null, models };
}

export function browserStats(jobs: DistributedJob[]): StatusData["browser"] {
  const terminal = jobs.filter((j) => j.status === "completed" || j.status === "failed");
  const latency = terminal.map((j) => j.totals.latencyMs ?? 0).filter((x) => x > 0);
  // A replacement unit's assignedAt minus the unit it replaced being assigned: how long a lost unit sat.
  const reassign: number[] = [];
  for (const j of jobs) {
    const byId = new Map(j.units.map((u) => [u.id, u]));
    for (const u of j.units) {
      const prev = u.replacedUnitId ? byId.get(u.replacedUnitId) : undefined;
      if (prev) reassign.push(u.assignedAt - prev.assignedAt);
    }
  }
  return {
    window: jobs.length,
    jobs: terminal.length,
    unitsVerified: jobs.reduce((s, j) => s + j.totals.verified, 0),
    unitsFailed: jobs.reduce((s, j) => s + j.totals.failed, 0),
    reassigned: jobs.reduce((s, j) => s + j.totals.reassigned, 0),
    reassignMedianMs: pct(reassign.filter((x) => x > 0), 50),
    latencyP50Ms: pct(latency, 50),
    latencyP95Ms: pct(latency, 95),
  };
}

/** Parses the incident log: every `## <date> — <title>` heading and the paragraph that follows it. */
export function parseIncidents(md: string): Incident[] {
  const out: Incident[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^## (\d{4}-\d{2}-\d{2})\s*[—-]\s*(.+)$/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const para: string[] = [];
    while (j < lines.length && lines[j].trim() && !lines[j].startsWith("#")) para.push(lines[j++]);
    const summary = para
      .join(" ")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();
    out.push({ date: m[1], title: m[2].trim(), summary });
  }
  return out;
}

async function incidents(): Promise<Incident[]> {
  try {
    const md = await readFile(path.join(process.cwd(), "gitbook", "trust", "incident-log.md"), "utf8");
    return parseIncidents(md);
  } catch {
    return [];
  }
}

async function build(): Promise<Omit<StatusData, "asOf">> {
  const store = getStore();
  const section = async <T>(read: () => Promise<T>): Promise<T | null> => withTimeout(read().catch(() => null), SECTION_MS, null);
  const [db, epochs, ijobs, djobs, log] = await Promise.all([
    database(),
    section(() => store.listEpochs(48)),
    section(() => listInferenceJobs(200)),
    section(() => listJobs(50)),
    incidents(),
  ]);
  return {
    database: db,
    settlement: epochs ? settlementStats(epochs) : null,
    inference: ijobs ? inferenceStats(ijobs) : null,
    browser: djobs ? browserStats(djobs) : null,
    incidents: log,
  };
}

/** Cached 30 s per instance; serves the last good body with its own timestamp when the store is down. */
export async function statusData(): Promise<StatusData & { stale: boolean }> {
  const s = await lastKnownGood("status", 30_000, build);
  return { ...s.body, asOf: s.asOf, stale: s.stale };
}
