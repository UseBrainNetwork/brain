import type { HeartbeatBody } from "@/node/protocol";
import { signedNodeRoute } from "@/services/coordinator/http";
import { BENCHMARK_TTL_MS, scheduleBenchmark } from "@/services/coordinator/benchmark";
import { heartbeatNativeNode } from "@/services/coordinator/registry";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

/** POST /api/coordinator/heartbeat — telemetry, loaded models, drain flag. Keeps the node ONLINE. */
export const POST = signedNodeRoute(async (node, raw) => {
  const body = raw as unknown as HeartbeatBody;
  const n = await heartbeatNativeNode(node.nodeId, body.telemetry ?? ({} as HeartbeatBody["telemetry"]), body.capabilities, body.draining);
  if (n.benchmark.basis === "unmeasured" || (n.benchmark.at != null && Date.now() - n.benchmark.at > BENCHMARK_TTL_MS)) await scheduleBenchmark(n.nodeId);
  return json({ state: n.state, serverTime: Date.now(), ...(n.banReason ? { instruction: "stop" } : {}) });
});
