import type { ComputeOrder } from "@/domain/economy";
import type { NetworkEvent } from "@/domain/types";
import { eventBus } from "@/services/eventBus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Orders carry customer prompts and outputs, and native-node progress events carry streamed
 * output text (the in-process observer needs it). The public stream only ever sees routing
 * facts and sizes, never content.
 */
function redact(e: NetworkEvent): NetworkEvent | { type: "order.updated"; at: number; order: Pick<ComputeOrder, "orderId" | "status" | "mode" | "privacy" | "workload" | "model" | "createdAt" | "completedAt" | "receiptId" | "decisionId" | "error"> } {
  if (e.type === "njob.progress") return { ...e, delta: "" };
  if (e.type !== "order.updated") return e;
  const { orderId, status, mode, privacy, workload, model, createdAt, completedAt, receiptId, decisionId, error } = e.order;
  return { type: "order.updated", at: e.at, order: { orderId, status, mode, privacy, workload, model, createdAt, completedAt, receiptId, decisionId, error } };
}

/** Server-Sent Events stream of REAL network events. */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup();
        }
      };
      send(`retry: 3000\n\n`);
      // Heartbeats are one event per node per 10 s and nothing in the browser consumes them; with
      // hundreds of nodes they were most of the stream's bytes and client parse work.
      const unsubscribe = eventBus.subscribe((e) => {
        if (e.type === "node.heartbeat") return;
        send(`data: ${JSON.stringify(redact(e))}\n\n`);
      });
      // Keep-alive only. The offline sweep runs on request paths that read nodes; running it here
      // multiplied one database sweep per viewer per 10 s across every long-lived stream instance.
      const ping = setInterval(() => send(`: ping\n\n`), 10_000);
      cleanup = () => {
        unsubscribe();
        clearInterval(ping);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
