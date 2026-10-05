/**
 * Resolve to `fallback` if `p` takes longer than `ms`. The original promise keeps running; attach
 * your own catch to it if its rejection matters. Used to keep the chat hot path moving when the
 * store is slow: bookkeeping degrades, the answer still streams.
 */
export function withTimeout<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let t: ReturnType<typeof setTimeout>;
  const timer = new Promise<F>((r) => {
    t = setTimeout(() => r(fallback), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(t)), timer]);
}

const inflight = new Set<Promise<unknown>>();

/**
 * Fire-and-forget with a logged failure, never an unhandled rejection. Every background promise is
 * tracked so a request handler can `await settleBackground()` inside `after()` and keep the
 * serverless function alive until the writes it deferred have landed.
 */
export function background(label: string, p: Promise<unknown>): Promise<unknown> {
  const tracked = p.catch((e) => console.error(`[bg:${label}]`, e instanceof Error ? `${e.name}: ${e.message}` : e));
  inflight.add(tracked);
  void tracked.finally(() => inflight.delete(tracked));
  return tracked;
}

/** Waits for all background work started so far (including work started while waiting). */
export async function settleBackground(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}
