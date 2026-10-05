import type { NetworkEvent } from "@/domain/types";

type Listener = (e: NetworkEvent) => void;

/**
 * In-process pub/sub for real network events (node joins, verified jobs...).
 * The SSE route fans these out to browsers. Swap for Redis/NATS when running >1 instance.
 */
class EventBus {
  private listeners = new Set<Listener>();
  private recent: NetworkEvent[] = [];

  publish(e: NetworkEvent) {
    this.recent.push(e);
    if (this.recent.length > 200) this.recent.shift();
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a broken subscriber must not break publishers */
      }
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  history(since = 0): NetworkEvent[] {
    return this.recent.filter((e) => e.at > since);
  }
}

const g = globalThis as typeof globalThis & { __brainBus?: EventBus };
export const eventBus = (g.__brainBus ??= new EventBus());
