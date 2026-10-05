import type { ComputeNode, NetworkEvent } from "@/domain/types";
import { mulberry32 } from "@/network/workloads";
import { deviceClasses } from "@/services/mock/mockData";
import { FIRST_SIM_JOB, hexId, mockDeviceClass, mockJob } from "@/services/mock/mockNetwork";

/**
 * Realtime transport abstraction. The store merges any number of sources.
 * Replace SimulatedSource with a real feed by removing it from createSources().
 */
export interface NetworkEventSource {
  readonly name: string;
  connect(emit: (e: NetworkEvent) => void): () => void;
}

/** DEMO: synthetic network activity around the baseline in services/mock/mockData.ts. */
export class SimulatedSource implements NetworkEventSource {
  readonly name = "simulated";
  connect(emit: (e: NetworkEvent) => void) {
    const rnd = mulberry32((Date.now() & 0xffffffff) >>> 0);
    // Job numbers advance with wall-clock so every visitor sees the same counter range.
    let jobNum = FIRST_SIM_JOB + Math.floor((Date.now() / 1000) % 100_000) * 3;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let balance = 0;

    const loop = (fn: () => void, min: number, max: number) => {
      const tick = () => {
        fn();
        timers.push(setTimeout(tick, min + (rnd() % (max - min))));
      };
      timers.push(setTimeout(tick, min + (rnd() % (max - min))));
    };

    loop(() => {
      const now = Date.now();
      const job = mockJob(jobNum++, now);
      emit({ type: "job.submitted", at: now, job: { ...job, status: "executing" } });
      timers.push(setTimeout(() => emit({ type: "job.completed", at: Date.now(), job }), Math.min(job.latencyMs ?? 1000, 2600)));
    }, 380, 900);

    loop(() => {
      const now = Date.now();
      // Joins and leaves stay balanced so the simulated count hovers at baseline.
      const join = balance <= 0 ? rnd() % 3 !== 0 : rnd() % 3 === 0;
      if (join) {
        const dc = mockDeviceClass(rnd);
        const prof = deviceClasses.find((d) => d.id === dc)!;
        const node: ComputeNode = {
          id: hexId(rnd),
          deviceClass: dc,
          status: "idle",
          computeScore: Math.round(prof.medianScore * (0.7 + (rnd() % 600) / 1000)),
          advertisedMemoryGb: Math.max(1, Math.round(prof.advertisedMemoryGb * (0.6 + (rnd() % 800) / 1000))),
          joinedAt: now,
          lastHeartbeatAt: now,
          verifiedJobs: 0,
          failedJobs: 0,
          verifiedComputeUnits: 0,
          reputation: 0.75,
          provenance: "simulated",
        };
        balance++;
        emit({ type: "node.joined", at: now, node });
      } else {
        balance--;
        emit({ type: "node.left", at: now, nodeId: hexId(rnd), memoryGb: 2 + (rnd() % 14) });
      }
    }, 1800, 4200);

    loop(() => emit({ type: "node.verified", at: Date.now(), nodeId: hexId(rnd), units: 3 + (rnd() % 22) }), 1400, 3200);

    return () => timers.forEach(clearTimeout);
  }
}

/** Real events from this server (node joins, verified jobs) via Server-Sent Events. */
export class SSESource implements NetworkEventSource {
  readonly name = "sse";
  constructor(private url = "/api/network/stream") {}
  connect(emit: (e: NetworkEvent) => void) {
    if (typeof EventSource === "undefined") return () => {};
    const es = new EventSource(this.url);
    es.onmessage = (m) => {
      try {
        emit(JSON.parse(m.data) as NetworkEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => es.close();
  }
}

/** External event bus (e.g. a dedicated realtime service). Reconnects with backoff. */
export class WebSocketSource implements NetworkEventSource {
  readonly name = "websocket";
  constructor(private url: string) {}
  connect(emit: (e: NetworkEvent) => void) {
    let ws: WebSocket | null = null;
    let closed = false;
    let delay = 1000;
    const open = () => {
      ws = new WebSocket(this.url);
      ws.onopen = () => (delay = 1000);
      ws.onmessage = (m) => {
        try {
          emit(JSON.parse(String(m.data)) as NetworkEvent);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!closed) setTimeout(open, (delay = Math.min(delay * 2, 30_000)));
      };
    };
    open();
    return () => {
      closed = true;
      ws?.close();
    };
  }
}

export function createSources(): NetworkEventSource[] {
  const ws = process.env.NEXT_PUBLIC_BRAIN_WS_URL;
  return [new SimulatedSource(), ws ? new WebSocketSource(ws) : new SSESource()];
}
