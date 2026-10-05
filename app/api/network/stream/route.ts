import { eventBus } from "@/services/eventBus";
import { sweepOffline } from "@/services/nodes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
      const unsubscribe = eventBus.subscribe((e) => send(`data: ${JSON.stringify(e)}\n\n`));
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
