import "server-only";
import type { PrivacyRequirement } from "@/domain/economy";
import type { ChatTurn } from "@/inference/tokenizer";
import { runNetworkChat, type NetworkRunSummary } from "@/services/inference";
import { NodeError } from "@/services/nodes";
import type { BrainRunSummary } from "./chatStream";

export interface NetworkStreamOptions {
  messages: ChatTurn[];
  maxTokens: number;
  temperature: number;
  chatId: string;
  model: string;
  t0: number;
  privacy: PrivacyRequirement;
  onComplete?: (summary: BrainRunSummary) => Promise<void>;
}

/**
 * SSE for BROWSER_ONLY chat: tokens come from contributor nodes running the model's layers. Same
 * frame shapes as the upstream path (`chat.completion.chunk`, `event: brain`, `[DONE]`) plus
 * `event: status` lines while the pipeline is being set up, so the UI can say what is happening
 * during the multi-second prefill.
 */
export function networkChatStream(o: NetworkStreamOptions): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const created = Math.floor(o.t0 / 1000);
  return new ReadableStream<Uint8Array>({
    async start(ctl) {
      const send = (s: string) => ctl.enqueue(enc.encode(s));
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        send(`data: ${JSON.stringify({ id: o.chatId, object: "chat.completion.chunk", created, model: o.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const brainOf = (n: NetworkRunSummary | null, error?: string): BrainRunSummary => ({
        orderId: n?.sessionId ?? o.chatId,
        receiptId: null,
        mode: "BROWSER_ONLY",
        privacy: o.privacy,
        target: "BROWSER_NETWORK",
        provider: "brain-network",
        model: n ? `brain/${n.model}` : null,
        nodesUsed: n ? n.stages.reduce((a, s) => a + s.nodes.filter((x) => x.hops > 0).length, 0) : 0,
        latencyMs: Date.now() - o.t0,
        cost: null,
        verification: n ? n.verification : null,
        verified: n?.verified ?? false,
        usage: n ? { inputUnits: n.promptTokens, outputUnits: n.outputTokens } : undefined,
        attached: null,
        network: n,
        status: n && n.finishReason !== "error" ? "COMPLETED" : "FAILED",
        error: error ?? n?.error,
      });
      let first = true;
      try {
        const summary = await runNetworkChat({ messages: o.messages, maxTokens: o.maxTokens, temperature: o.temperature, topP: 0.95 }, (e) => {
          if (e.type === "status") send(`event: status\ndata: ${JSON.stringify({ detail: e.detail })}\n\n`);
          else {
            if (first) {
              chunk({ role: "assistant", content: "" });
              first = false;
            }
            chunk({ content: e.text });
          }
        });
        chunk({}, summary.finishReason === "error" ? "stop" : summary.finishReason);
        const brain = brainOf(summary);
        if (summary.finishReason === "error") send(`event: error\ndata: ${JSON.stringify({ error: { code: "network_inference_failed", message: summary.error ?? "network inference failed" }, brain })}\n\n`);
        else send(`event: brain\ndata: ${JSON.stringify(brain)}\n\n`);
        send("data: [DONE]\n\n");
        await o.onComplete?.(brain).catch(() => {});
      } catch (e) {
        const code = e instanceof NodeError ? e.code : "network_inference_failed";
        const message = code.startsWith("no_capacity")
          ? `The network cannot run this model right now: ${code.slice("no_capacity:".length) || "not enough nodes hold the model"}. Nodes load a stage when they open /node with inference enabled.`
          : code === "busy"
            ? "The network is serving its maximum number of sessions. Try again in a moment."
            : e instanceof Error
              ? e.message
              : "network inference failed";
        send(`event: error\ndata: ${JSON.stringify({ error: { code, message }, brain: brainOf(null, message) })}\n\n`);
        send("data: [DONE]\n\n");
      } finally {
        ctl.close();
      }
    },
  });
}
