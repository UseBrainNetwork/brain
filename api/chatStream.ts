import "server-only";
import { after } from "next/server";
import { settleBackground, withTimeout } from "@/lib/async";
import type { ComputeOrder, ComputeReceipt, PrivacyRequirement, RoutingMode } from "@/domain/economy";
import { placeStreamingOrder, type PlaceOrderInput } from "@/engine/orders";
import { attachCompute, type AttachedComputeSummary } from "@/services/attachedCompute";
import type { NetworkRunSummary } from "@/services/inference";
import { getReceipt } from "@/services/receipts";
import { getInferenceJob } from "@/services/coordinator/jobs";
import { getNativeNode } from "@/services/coordinator/registry";
import { reframeStream } from "./gateway";

/**
 * Metadata BRAIN attaches to every answer: the "HOW BRAIN RAN THIS" panel and the `brain` field
 * of the public API are both built from this. Every value comes from the persisted order and
 * receipt; nothing is inferred client-side.
 */
export interface BrainRunSummary {
  orderId: string;
  decisionId?: string;
  planId?: string;
  receiptId: string | null;
  mode: RoutingMode;
  privacy: PrivacyRequirement;
  target: string | null;
  provider: string | null;
  model: string | null;
  nodesUsed: number;
  latencyMs: number;
  cost: ComputeReceipt["customerCost"];
  verification: string | null;
  /** True only when the server verified the work itself (spot-checks / redundancy). */
  verified: boolean;
  usage?: { inputUnits: number; outputUnits: number };
  /**
   * NATIVE_NETWORK runs: the Brain Node that produced the answer and why the router picked it.
   * Hardware fields are omitted on purpose (they are node-reported); reliability and class are
   * coordinator-measured. Absent for every other target.
   */
  node?: { id: string; region: string | null; reliability: number; computeClass: string | null; routing: string | null; verification: string | null };
  /**
   * Compute attached to this request and dispatched to the browser network after the answer completed.
   * It did not produce the answer; it is verifiable work sized by this request. null = none dispatched.
   */
  attached?: AttachedComputeSummary | null;
  /**
   * BROWSER_ONLY mode: the answer itself was produced by contributor nodes running the model's
   * layers (services/inference.ts). Present only on network runs.
   */
  network?: NetworkRunSummary | null;
  status: ComputeOrder["status"];
  error?: string;
}

/** Terminal order → summary, plus the attached-compute dispatch. Both chat routes go through this. */
export async function finalize(order: ComputeOrder, t0: number, mode: RoutingMode, privacy: PrivacyRequirement) {
  const summary = await summarize(order, t0, mode, privacy);
  try {
    summary.brain.attached = await withTimeout(attachCompute(order, summary.brain.usage), ATTACH_BUDGET_MS, null);
  } catch (e) {
    console.error("attached compute", e);
    summary.brain.attached = null;
  }
  return summary;
}

/** Store time we spend looking up the receipt before answering with what we have. */
const RECEIPT_BUDGET_MS = 6_000;
/** Store time we wait for the attached-compute dispatch while the stream is still open. */
const ATTACH_BUDGET_MS = 4_000;

export async function summarize(order: ComputeOrder, t0: number, mode: RoutingMode, privacy: PrivacyRequirement, known: ComputeReceipt | null = null): Promise<{ receipt: ComputeReceipt | null; brain: BrainRunSummary }> {
  const receipt = known ?? (order.receiptId ? await withTimeout(getReceipt(order.receiptId).catch(() => null), RECEIPT_BUDGET_MS, null) : null);
  return {
    receipt,
    brain: {
      orderId: order.orderId,
      decisionId: order.decisionId,
      planId: order.planId,
      receiptId: order.receiptId ?? null,
      mode,
      privacy,
      target: receipt?.route?.target ?? null,
      provider: receipt?.route?.providerId ?? null,
      model: receipt?.model ?? null,
      nodesUsed: receipt?.nodesUsed.length ?? 0,
      latencyMs: Date.now() - t0,
      cost: receipt?.customerCost ?? null,
      verification: receipt?.verificationMethod ?? null,
      // Only server-verified work counts: spot-checks, canaries, redundancy. Node-reported and upstream answers do not.
      verified: receipt ? receipt.verificationMethod !== "unverified-provider-response" && receipt.verificationMethod !== "node-reported" : false,
      usage: receipt?.tokens ? { inputUnits: receipt.tokens.prompt, outputUnits: receipt.tokens.completion } : undefined,
      node: receipt?.route?.target === "NATIVE_NETWORK" ? await nodeBlock(receipt) : undefined,
      status: order.status,
      error: order.error,
    },
  };
}

async function nodeBlock(receipt: ComputeReceipt): Promise<BrainRunSummary["node"]> {
  const nodeId = receipt.nodesUsed[0];
  if (!nodeId) return undefined;
  const [n, j] = await Promise.all([getNativeNode(nodeId).catch(() => null), getInferenceJob(receipt.jobId).catch(() => null)]);
  if (!n) return undefined;
  const v = j?.verification;
  return {
    id: n.nodeId,
    region: n.region,
    reliability: n.reputation,
    computeClass: n.benchmark.computeClass,
    routing: j?.routing?.reason ?? null,
    verification: v ? `${v.kind}:${v.status}` : null,
  };
}

export interface StreamOptions {
  input: PlaceOrderInput & { request: Extract<PlaceOrderInput["request"], { kind: "chat" }> };
  customerId: string;
  chatId: string;
  t0: number;
  mode: RoutingMode;
  privacy: PrivacyRequirement;
  /** Runs after the order is terminal (credits, usage records). Errors are swallowed so the stream still closes cleanly. */
  onComplete?: (order: ComputeOrder, summary: { receipt: ComputeReceipt | null; brain: BrainRunSummary }) => Promise<void>;
}

/**
 * OpenAI-style SSE: token chunks first (re-framed with our ids), then `event: brain` with the run
 * summary, then `data: [DONE]`. Failures after routing arrive as `event: error` with the same
 * `brain` object so the client can still show what was attempted.
 */
export async function chatEventStream(o: StreamOptions): Promise<ReadableStream<Uint8Array>> {
  const { firstByte, done, persisted } = await placeStreamingOrder(o.input, o.customerId);
  const { stream } = await firstByte;
  const enc = new TextEncoder();
  const created = Math.floor(o.t0 / 1000);
  return new ReadableStream<Uint8Array>({
    async start(ctl) {
      try {
        if (stream) {
          const reader = reframeStream(stream, o.chatId, o.input.request.model, created).getReader();
          for (;;) {
            const { value, done: d } = await reader.read();
            if (d) break;
            ctl.enqueue(value);
          }
        }
        const { order, receipt } = await done;
        if (!stream && order.status === "COMPLETED") {
          ctl.enqueue(enc.encode(`data: ${JSON.stringify({ id: o.chatId, object: "chat.completion.chunk", created, model: o.input.request.model, choices: [{ index: 0, delta: { role: "assistant", content: order.output ?? "" }, finish_reason: "stop" }] })}\n\n`));
        }
        // The run summary goes out as soon as the receipt is known; bookkeeping must not hold the stream.
        const summary = await summarize(order, o.t0, o.mode, o.privacy, receipt);
        if (order.status !== "COMPLETED") {
          ctl.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ error: { code: order.status === "REJECTED" ? "no_provider_available" : "upstream_failed", message: order.error ?? "execution failed" }, brain: summary.brain })}\n\n`));
        } else {
          ctl.enqueue(enc.encode(`event: brain\ndata: ${JSON.stringify(summary.brain)}\n\n`));
        }
        // Attached compute: dispatched now; reported on this stream only if it lands within budget.
        const attach = order.status === "COMPLETED" ? attachCompute(order, summary.brain.usage).catch((e) => (console.error("attached compute", e), null)) : Promise.resolve(null);
        const attached = await withTimeout(attach, ATTACH_BUDGET_MS, undefined);
        if (attached !== undefined) {
          summary.brain.attached = attached;
          ctl.enqueue(enc.encode(`event: attached\ndata: ${JSON.stringify(attached)}\n\n`));
        }
        ctl.enqueue(enc.encode("data: [DONE]\n\n"));
        // Credits, usage records and a late attach finish after the response; the platform keeps the function alive.
        const tail = async () => {
          summary.brain.attached = (await attach) ?? summary.brain.attached;
          try {
            await o.onComplete?.(order, summary);
          } catch (e) {
            console.error("chat onComplete", e);
          }
          await persisted;
          await settleBackground();
        };
        try {
          after(tail);
        } catch {
          void tail();
        }
      } catch (e) {
        ctl.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ error: { code: "stream_failed", message: e instanceof Error ? e.message : "stream failed" } })}\n\n`));
      } finally {
        ctl.close();
      }
    },
  });
}

export const sseHeaders = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" };
