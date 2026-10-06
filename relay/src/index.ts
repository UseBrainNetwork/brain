import { DurableObject } from "cloudflare:workers";
import {
  REPLICA_TOLERANCE,
  TOP_K,
  compareOutputs,
  decodeFrame,
  encodeFrame,
  headColumns,
  verifyTicket,
  type DoneMsg,
  type EndMsg,
  type FailMsg,
  type HopMsg,
  type LapMsg,
  type LapStage,
  type PresenceNode,
  type ResultMsg,
  type StageMsg,
  type Ticket,
} from "../../inference/protocol";

/**
 * BRAIN inference relay. One Durable Object per model holds a WebSocket to every contributor node
 * serving that model and to each gateway session. The gateway sends a "lap" (token ids for a
 * prefill, a decode step or a speculative verify batch); the relay walks it through the pipeline
 * stage by stage, forwarding the primary node's output to the next stage as soon as it arrives,
 * and reports every node's result back to the gateway, with the distance to its replica's output
 * when both answered. Nothing here decides rewards: the gateway settles from these reports.
 *
 * Why a relay at all: Vercel functions cannot hold sockets, and a hop through Postgres polling
 * cost ~500 ms. A hop here costs the node's round trip plus its GPU time.
 */

export interface Env {
  RELAY: DurableObjectNamespace<ModelRelay>;
  RELAY_SECRET: string;
}

interface Attachment {
  role: "node" | "gateway";
  nodeId?: string;
  stage?: number;
  since: number;
}

interface Pending {
  hop: string;
  lapKey: string;
  stage: number;
  nodeId: string;
  role: "primary" | "replica";
  sentAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface StageOutcome {
  ok: boolean;
  payload?: Uint8Array;
  kind: "hidden" | "topk";
}

interface Lap {
  key: string;
  session: string;
  step: number;
  plan: LapStage[];
  seq: number;
  positions: number[];
  cacheLen: number;
  hopMs: number;
  gateway: WebSocket;
  startedAt: number;
  outcomes: Map<number, { primary?: StageOutcome; replica?: StageOutcome }>;
  forwarded: Set<number>;
  pending: Set<string>;
  finished: boolean;
  killer: ReturnType<typeof setTimeout>;
}

export class ModelRelay extends DurableObject<Env> {
  private pendings = new Map<string, Pending>();
  private laps = new Map<string, Lap>();
  private sessionPlans = new Map<string, LapStage[]>();
  private hopSeq = 0;

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const ticket = (req as Request & { ticket?: Ticket }).ticket ?? (await this.ticketFrom(req));
    if (!ticket) return new Response("unauthorized", { status: 401 });

    if (url.pathname === "/presence") return Response.json({ nodes: this.presence() });

    if (url.pathname === "/ws/node" || url.pathname === "/ws/gateway") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
      const role = url.pathname === "/ws/node" ? "node" : "gateway";
      if (ticket.role !== role) return new Response("wrong role", { status: 403 });
      if (role === "node" && (!ticket.nodeId || ticket.stage === undefined)) return new Response("node ticket needs nodeId and stage", { status: 400 });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      const att: Attachment = { role, nodeId: ticket.nodeId, stage: ticket.stage, since: Date.now() };
      // A node that reconnects replaces its old socket.
      if (role === "node") for (const old of this.ctx.getWebSockets(`node:${ticket.nodeId}`)) old.close(4000, "replaced");
      const tags = role === "node" ? ["role:node", `node:${ticket.nodeId}`, `stage:${ticket.stage}`] : ["role:gateway"];
      this.ctx.acceptWebSocket(server, tags);
      server.serializeAttachment(att);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }

  private async ticketFrom(req: Request): Promise<Ticket | null> {
    const url = new URL(req.url);
    const token = url.searchParams.get("ticket") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    return token ? verifyTicket(token, this.env.RELAY_SECRET) : null;
  }

  presence(): PresenceNode[] {
    const out: PresenceNode[] = [];
    for (const ws of this.ctx.getWebSockets("role:node")) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.nodeId !== undefined && a.stage !== undefined) out.push({ nodeId: a.nodeId, stage: a.stage, since: a.since });
    }
    return out;
  }

  private nodeSocket(nodeId: string): WebSocket | undefined {
    return this.ctx.getWebSockets(`node:${nodeId}`)[0];
  }

  private send(ws: WebSocket, header: unknown, payload?: Uint8Array): boolean {
    try {
      ws.send(encodeFrame(header, payload));
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------- socket events */

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === "string") return;
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    let frame;
    try {
      frame = decodeFrame<{ t: string }>(message);
    } catch {
      return;
    }
    if (att.role === "gateway") {
      if (frame.header.t === "lap") this.startLap(ws, frame.header as unknown as LapMsg, frame.payload);
      else if (frame.header.t === "end") this.endSession((frame.header as unknown as EndMsg).session);
    } else if (frame.header.t === "result") {
      this.onResult(att, frame.header as unknown as ResultMsg, frame.payload);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role === "node" && att.nodeId) {
      // Fail its pending hops now rather than at the deadline.
      for (const p of [...this.pendings.values()]) if (p.nodeId === att.nodeId) this.resolve(p, { ok: false, kind: "hidden" }, 0, "node disconnected");
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /* ---------------------------------------------------------------- laps */

  private startLap(gateway: WebSocket, msg: LapMsg, tokens: Uint8Array): void {
    const key = `${msg.session}:${msg.step}`;
    if (this.laps.has(key)) return;
    if (!Array.isArray(msg.plan) || msg.plan.length === 0 || tokens.length !== msg.seq * 4) {
      this.send(gateway, { t: "fail", session: msg.session, step: msg.step, stage: -1, reason: "bad lap" } satisfies FailMsg);
      return;
    }
    const hopMs = Math.max(500, Math.min(60_000, msg.hopMs || 8_000));
    const lap: Lap = {
      key,
      session: msg.session,
      step: msg.step,
      plan: msg.plan,
      seq: msg.seq,
      positions: msg.positions,
      cacheLen: msg.cacheLen,
      hopMs,
      gateway,
      startedAt: Date.now(),
      outcomes: new Map(),
      forwarded: new Set(),
      pending: new Set(),
      finished: false,
      killer: setTimeout(() => this.killLap(key, "lap timeout"), hopMs * msg.plan.length + 2_000),
    };
    this.laps.set(key, lap);
    this.sessionPlans.set(msg.session, msg.plan);
    this.issueStage(lap, 0, tokens, "tokens");
  }

  private issueStage(lap: Lap, si: number, payload: Uint8Array, kind: "tokens" | "hidden"): void {
    const st = lap.plan[si];
    if (!st || st.nodes.length === 0) return this.failLap(lap, si, "stage has no node");
    const outcome = { kind: (si === lap.plan.length - 1 ? "topk" : "hidden") as "hidden" | "topk" };
    st.nodes.slice(0, 2).forEach((nodeId, i) => {
      const role = i === 0 ? "primary" : "replica";
      const hop = `${lap.key}:${st.stage}:${(this.hopSeq++).toString(36)}`;
      const ws = this.nodeSocket(nodeId);
      const p: Pending = { hop, lapKey: lap.key, stage: st.stage, nodeId, role, sentAt: Date.now(), timer: setTimeout(() => this.resolve(p, { ok: false, kind: outcome.kind }, 0, "deadline"), lap.hopMs) };
      this.pendings.set(hop, p);
      lap.pending.add(hop);
      const msg: HopMsg = { t: "hop", hop, session: lap.session, step: lap.step, stage: st.stage, seq: lap.seq, positions: lap.positions, cacheLen: lap.cacheLen, kind };
      if (!ws || !this.send(ws, msg, payload)) this.resolve(p, { ok: false, kind: outcome.kind }, 0, ws ? "send failed" : "node not connected");
    });
  }

  private onResult(att: Attachment, msg: ResultMsg, payload: Uint8Array): void {
    const p = this.pendings.get(msg.hop);
    if (!p || p.nodeId !== att.nodeId) return;
    const lap = this.laps.get(p.lapKey);
    const kind = lap && p.stage === lap.plan[lap.plan.length - 1].stage ? "topk" : "hidden";
    if (!msg.ok) return this.resolve(p, { ok: false, kind }, msg.gpuMs, msg.error ?? "node error");
    // Shape check: the only thing the relay can validate without running the model.
    const expect = lap ? this.expectedBytes(lap, kind) : -1;
    if (expect >= 0 && payload.length !== expect) return this.resolve(p, { ok: false, kind }, msg.gpuMs, `malformed output (${payload.length} bytes, expected ${expect})`);
    this.resolve(p, { ok: true, payload: payload.slice(), kind }, msg.gpuMs);
  }

  private expectedBytes(lap: Lap, kind: "hidden" | "topk"): number {
    if (kind === "topk") return headColumns(lap.seq) * TOP_K * 8;
    // hidden width is not known to the relay; accept any f16 multiple of seq.
    return -1;
  }

  private resolve(p: Pending, outcome: StageOutcome, gpuMs: number, error?: string): void {
    if (!this.pendings.has(p.hop)) return;
    clearTimeout(p.timer);
    this.pendings.delete(p.hop);
    const lap = this.laps.get(p.lapKey);
    if (!lap) return;
    lap.pending.delete(p.hop);
    const slot = lap.outcomes.get(p.stage) ?? {};
    slot[p.role] = outcome;
    lap.outcomes.set(p.stage, slot);

    // Compare with the sibling when both are in.
    const sibling = p.role === "primary" ? slot.replica : slot.primary;
    let rms: number | null = null;
    if (sibling) {
      if (sibling.ok && outcome.ok && sibling.payload && outcome.payload) rms = compareOutputs(outcome.kind, sibling.payload, outcome.payload);
      else rms = null;
    }
    const report: StageMsg = { t: "stage", session: lap.session, step: lap.step, stage: p.stage, nodeId: p.nodeId, role: p.role, ok: outcome.ok, ms: Date.now() - p.sentAt, gpuMs: Math.max(0, Number(gpuMs) || 0), rms, error };
    this.send(lap.gateway, report);

    // Advance the pipeline.
    const si = lap.plan.findIndex((s) => s.stage === p.stage);
    if (!lap.forwarded.has(p.stage)) {
      const primary = slot.primary;
      const replica = slot.replica;
      const hasReplica = lap.plan[si].nodes.length >= 2;
      let chosen: StageOutcome | undefined;
      if (primary?.ok) chosen = primary;
      else if (primary && !primary.ok && replica?.ok) chosen = replica;
      else if (!hasReplica && primary && !primary.ok) return this.failLap(lap, si, error ?? "stage failed");
      else if (primary && !primary.ok && replica && !replica.ok) return this.failLap(lap, si, "both nodes failed");
      if (chosen?.payload) {
        lap.forwarded.add(p.stage);
        if (rms !== null && rms > REPLICA_TOLERANCE && p.role === "primary") {
          // Primary disagreed with an already-present replica: forward anyway (the gateway marks the
          // dispute and stops the session); the output is not trusted either way.
        }
        if (si === lap.plan.length - 1) this.finishLap(lap, chosen.payload);
        else this.issueStage(lap, si + 1, chosen.payload, "hidden");
      }
    }
    this.maybeCloseLap(lap);
  }

  private finishLap(lap: Lap, topk: Uint8Array): void {
    if (lap.finished) return;
    lap.finished = true;
    const done: DoneMsg = { t: "done", session: lap.session, step: lap.step, seq: lap.seq, ms: Date.now() - lap.startedAt };
    this.send(lap.gateway, done, topk);
  }

  private failLap(lap: Lap, si: number, reason: string): void {
    if (lap.finished) return;
    lap.finished = true;
    const fail: FailMsg = { t: "fail", session: lap.session, step: lap.step, stage: lap.plan[si]?.stage ?? si, reason };
    this.send(lap.gateway, fail);
    this.maybeCloseLap(lap);
  }

  private maybeCloseLap(lap: Lap): void {
    if (lap.pending.size === 0 && (lap.finished || lap.forwarded.size === lap.plan.length)) {
      clearTimeout(lap.killer);
      this.laps.delete(lap.key);
    }
  }

  private killLap(key: string, reason: string): void {
    const lap = this.laps.get(key);
    if (!lap) return;
    for (const hop of [...lap.pending]) {
      const p = this.pendings.get(hop);
      if (p) this.resolve(p, { ok: false, kind: "hidden" }, 0, reason);
    }
    if (!lap.finished) this.failLap(lap, -1, reason);
    clearTimeout(lap.killer);
    this.laps.delete(key);
  }

  private endSession(session: string): void {
    const plan = this.sessionPlans.get(session);
    this.sessionPlans.delete(session);
    for (const [key, lap] of this.laps) if (lap.session === session) this.killLap(key, "session ended");
    if (!plan) return;
    const seen = new Set<string>();
    for (const st of plan)
      for (const nodeId of st.nodes) {
        if (seen.has(nodeId)) continue;
        seen.add(nodeId);
        const ws = this.nodeSocket(nodeId);
        if (ws) this.send(ws, { t: "drop", session });
      }
  }
}

/* -------------------------------------------------------------------- worker */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "brain-relay" });
    if (!env.RELAY_SECRET) return new Response("relay not configured", { status: 500 });
    const token = url.searchParams.get("ticket") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const ticket = token ? await verifyTicket(token, env.RELAY_SECRET) : null;
    if (!ticket) return new Response("unauthorized", { status: 401 });
    const model = url.searchParams.get("model") ?? ticket.model;
    if (model !== ticket.model) return new Response("model mismatch", { status: 403 });
    const stub = env.RELAY.get(env.RELAY.idFromName(model));
    // The DO re-verifies the ticket from the same URL / header.
    return stub.fetch(req);
  },
};
