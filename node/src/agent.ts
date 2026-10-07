import { createHash } from "node:crypto";
import { filterAllowed } from "../models";
import { DEFAULTS, PROTOCOL_VERSION, type HeartbeatReply, type JobPayload, type NodeCapabilities, type RegisterReply, type WorkReply } from "../protocol";
import type { InferenceBackend } from "./backends/types";
import { detectHardware, sampleTelemetry } from "./hardware";
import type { Identity } from "./identity";
import { TransportError, type Transport } from "./transport";

export interface AgentConfig {
  mock: boolean;
  region: string | null;
  wallet?: string;
  maxConcurrency: number;
  askUsdPer1MTokens: number | null;
  /** Restrict advertised models to this subset of what the backend supports. */
  models?: string[];
  agentVersion: string;
  log?: (line: string) => void;
}

/**
 * The Brain Node agent loop:
 *   register → heartbeat every 15 s → long-poll for work → ensureLoaded → generate (streaming
 *   progress) → completed/failed → poll again.
 *
 * Progress is flushed at most every `flushMs` so a fast backend does not turn into hundreds of
 * requests per second. Every report is signed. A coordinator that goes away is retried with
 * backoff; a job whose deadline passes is cancelled locally and reported as a timeout.
 */
export class Agent {
  private stopping = false;
  private draining = false;
  private active = new Map<string, AbortController>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private log: (line: string) => void;
  private caps!: NodeCapabilities;

  constructor(
    private id: Identity,
    private transport: Transport,
    private backend: InferenceBackend,
    private cfg: AgentConfig,
  ) {
    this.log = cfg.log ?? ((l) => console.log(`${new Date().toISOString()} ${l}`));
  }

  private capabilities(): NodeCapabilities {
    let supported = filterAllowed(this.backend.supportedModels());
    if (this.cfg.models?.length) supported = supported.filter((m) => this.cfg.models!.includes(m));
    return { backend: this.backend.kind, supportedModels: supported, loadedModels: this.backend.loadedModels().filter((m) => supported.includes(m)), maxConcurrency: this.cfg.maxConcurrency, region: this.cfg.region, askUsdPer1MTokens: this.cfg.askUsdPer1MTokens };
  }

  async register(): Promise<RegisterReply> {
    const hardware = await detectHardware(this.cfg.mock);
    this.caps = this.capabilities();
    const reply = await this.transport.call<RegisterReply>("/api/coordinator/register", { protocol: PROTOCOL_VERSION, nodeId: this.id.nodeId, publicKey: this.id.publicKey, agentVersion: this.cfg.agentVersion, hardware, capabilities: this.caps, ...(this.cfg.wallet ? { wallet: this.cfg.wallet } : {}) });
    const gpu = hardware.gpus[0];
    this.log(`registered as ${reply.nodeId} (${reply.state}) · ${gpu ? `${gpu.model}${gpu.vramTotalMb ? ` ${Math.round(gpu.vramTotalMb / 1024)} GB` : ""} via ${gpu.source}` : "no GPU detected"} · models ${reply.acceptedModels.join(", ") || "none accepted"}`);
    if (!reply.acceptedModels.length) this.log("warning: the coordinator accepted none of this node's models; it will not receive work");
    return reply;
  }

  async heartbeat(): Promise<HeartbeatReply> {
    const caps = this.capabilities();
    const capsChanged = JSON.stringify(caps) !== JSON.stringify(this.caps);
    this.caps = caps;
    const telemetry = await sampleTelemetry(this.cfg.mock, this.active.size, this.cfg.maxConcurrency, caps.loadedModels, this.transport.rttMs());
    const reply = await this.transport.call<HeartbeatReply>("/api/coordinator/heartbeat", { telemetry, ...(capsChanged ? { capabilities: caps } : {}), draining: this.draining });
    if (reply.instruction === "stop") {
      this.log("coordinator asked this node to stop");
      void this.stop();
    } else if (reply.instruction === "drain") this.draining = true;
    return reply;
  }

  async run() {
    let backoff = 2_000;
    for (;;) {
      if (this.stopping) return;
      try {
        await this.register();
        backoff = 2_000;
        break;
      } catch (e) {
        this.log(`register failed: ${describe(e)}; retrying in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(60_000, backoff * 2);
      }
    }
    const beat = async () => {
      try {
        await this.heartbeat();
      } catch (e) {
        this.log(`heartbeat failed: ${describe(e)}`);
        if (e instanceof TransportError && e.status === 404) {
          // Coordinator forgot us (restart with memory store): register again.
          await this.register().catch(() => undefined);
        }
      }
    };
    this.heartbeatTimer = setInterval(() => void beat(), DEFAULTS.heartbeatMs);
    await beat();
    await this.workLoop();
  }

  private async workLoop() {
    let backoff = 1_000;
    while (!this.stopping) {
      if (this.draining || this.active.size >= this.cfg.maxConcurrency) {
        await sleep(500);
        continue;
      }
      try {
        const reply = await this.transport.call<WorkReply>("/api/coordinator/work", { waitMs: DEFAULTS.workPollMs }, { timeoutMs: DEFAULTS.workPollMs + 10_000 });
        backoff = 1_000;
        if (reply.job) void this.execute(reply.job);
      } catch (e) {
        this.log(`work poll failed: ${describe(e)}; retrying in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(30_000, backoff * 2);
      }
    }
  }

  private async execute(job: JobPayload) {
    const ctl = new AbortController();
    this.active.set(job.jobId, ctl);
    const deadlineTimer = setTimeout(() => ctl.abort("deadline"), Math.max(0, job.deadlineAt - Date.now()));
    const t0 = Date.now();
    const report = <T = unknown,>(suffix: string, body: unknown) => this.transport.call<T>(`/api/coordinator/jobs/${encodeURIComponent(job.jobId)}/${suffix}`, body);
    this.log(`job ${job.jobId} ${job.model} · ${job.messages.length} messages · max ${job.maxTokens} tokens`);
    try {
      const loaded = await this.backend.ensureLoaded(job.model, ctl.signal);
      await report("started", { backend: this.backend.kind, loaded });

      // Progress flushing: coalesce deltas, send in order, never overlap sends.
      let seq = 0;
      let pending = "";
      let pendingTokens = 0;
      let chain = Promise.resolve();
      let flushTimer: NodeJS.Timeout | null = null;
      const flush = () => {
        if (!pending) return chain;
        const delta = pending;
        const tokens = pendingTokens;
        const mySeq = seq++;
        pending = "";
        chain = chain.then(() => report("progress", { seq: mySeq, delta, tokens })).then(
          () => undefined,
          (e) => {
            // A rejected frame means the coordinator no longer wants this job (cancelled, timed out, re-assigned).
            this.log(`job ${job.jobId} progress rejected: ${describe(e)}`);
            ctl.abort("rejected");
          },
        );
        return chain;
      };
      const onDelta = (d: string, tokens: number) => {
        pending += d;
        pendingTokens = tokens;
        if (!flushTimer)
          flushTimer = setTimeout(() => {
            flushTimer = null;
            void flush();
          }, job.flushMs);
      };

      const out = await this.backend.generate(job, onDelta, ctl.signal);
      if (flushTimer) clearTimeout(flushTimer);
      await flush();
      if (ctl.signal.aborted) {
        const why = String(ctl.signal.reason ?? "cancelled");
        if (why !== "rejected") await report("failed", { reason: why === "deadline" ? "timeout" : "cancelled" }).catch(() => undefined);
        this.log(`job ${job.jobId} aborted (${why})`);
        return;
      }
      const res = await report<{ state: string; receiptId: string | null; failureReason: string | null }>("completed", { content: out.content, finishReason: out.finishReason, usage: out.usage, durationMs: Date.now() - t0, responseHash: createHash("sha256").update(out.content).digest("hex") });
      this.log(`job ${job.jobId} ${res.state.toLowerCase()} · ${out.usage.completion} tokens in ${Date.now() - t0} ms${res.receiptId ? ` · receipt ${res.receiptId}` : ""}${res.failureReason ? ` · ${res.failureReason}` : ""}`);
    } catch (e) {
      const msg = describe(e);
      const reason = /out of memory|OOM/i.test(msg) ? "oom" : /model|load/i.test(msg) ? "model_unavailable" : "backend_error";
      this.log(`job ${job.jobId} failed: ${msg}`);
      await report("failed", { reason, detail: msg.slice(0, 200) }).catch(() => undefined);
    } finally {
      clearTimeout(deadlineTimer);
      this.active.delete(job.jobId);
    }
  }

  /** Graceful stop: drain, let running jobs finish (up to 30 s), tell the coordinator, shut the backend down. */
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.draining = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const until = Date.now() + 30_000;
    while (this.active.size && Date.now() < until) await sleep(250);
    for (const c of this.active.values()) c.abort("shutdown");
    await this.transport.call("/api/coordinator/heartbeat", { telemetry: await sampleTelemetry(this.cfg.mock, 0, this.cfg.maxConcurrency, [], this.transport.rttMs()), draining: true }).catch(() => undefined);
    await this.backend.shutdown();
    this.log("stopped");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

