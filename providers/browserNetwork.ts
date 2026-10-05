import "server-only";
import { liveNodes } from "@/services/nodes";
import type { Candidate, ChatRequest, ChatResult, InferenceProvider } from "./types";

/**
 * The distributed browser pool.
 *
 * V1 honesty: the pool runs verified tensor/verification workloads today, not LLM decoding.
 * `evaluate` reports real live capacity but marks chat models incompatible until sharded
 * inference ships (NEXT_STEPS.md). The router then falls through to the next target.
 */
export class BrowserNetworkProvider implements InferenceProvider {
  readonly id = "brain-browser-pool";
  readonly target = "BROWSER_NETWORK" as const;

  /** Models the pool can execute end-to-end. Grows as kernels land. */
  static readonly supportedModels = new Set<string>([]);

  async evaluate(model: string): Promise<Candidate> {
    const nodes = await liveNodes();
    const compatible = BrowserNetworkProvider.supportedModels.has(model);
    const notes: string[] = [];
    if (!compatible) notes.push("sharded LLM execution not enabled in V1");
    if (nodes.length === 0) notes.push("no live browser nodes");
    return {
      target: this.target,
      providerId: this.id,
      compatible,
      available: nodes.length > 0,
      notes,
      estLatencyMs: 2400,
      costPer1M: null,
      reliability: 0.9,
      capacity: Math.min(1, nodes.length / 50),
    };
  }

  async complete(_req: ChatRequest): Promise<ChatResult> {
    throw new Error("browser pool cannot execute chat models yet");
  }
}
