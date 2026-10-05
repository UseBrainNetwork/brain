import type { ComputeOrder } from "@/domain/economy";
import type { NetworkEvent } from "@/domain/types";
import { eventBus } from "@/services/eventBus";
import { sweepOffline } from "@/services/nodes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Orders carry customer prompts and outputs. The public stream only ever sees the order's
 * routing facts, never its content.
 */
function redact(e: NetworkEvent): NetworkEvent | { type: "order.updated"; at: number; order: Pick<ComputeOrder, "orderId" | "status" | "mode" | "privacy" | "workload" | "model" | "createdAt" | "completedAt" | "receiptId" | "decisionId" | "error"> } {
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
      const unsubscribe = eventBus.subscribe((e) => send(`data: ${JSON.stringify(redact(e))}\n\n`));
      const ping = setInterval(() => {
        send(`: ping\n\n`);
        void sweepOffline();
      }, 10_000);
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
