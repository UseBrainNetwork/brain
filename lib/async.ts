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

/** Fire-and-forget with a logged failure, never an unhandled rejection. */
export function background(label: string, p: Promise<unknown>): Promise<unknown> {
  return p.catch((e) => console.error(`[bg:${label}]`, e instanceof Error ? `${e.name}: ${e.message}` : e));
}
