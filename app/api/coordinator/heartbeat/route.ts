import type { HeartbeatBody } from "@/node/protocol";
import { importedSpecsForWire, signedNodeRoute } from "@/services/coordinator/http";
import { BENCHMARK_TTL_MS, scheduleBenchmark } from "@/services/coordinator/benchmark";
import { scheduleCanary } from "@/services/coordinator/verify";
import { heartbeatNativeNode } from "@/services/coordinator/registry";
import { importOffersFor, listImportedModels } from "@/services/modelImports";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

/**
 * POST /api/coordinator/heartbeat — telemetry, loaded models, drain flag. Keeps the node ONLINE.
 * The reply carries the imported-model table and, for nodes that opted in, which of those models to
 * pull next (sized against the node's reported memory and its disk budget).
 */
export const POST = signedNodeRoute(async (node, raw) => {
  const body = raw as unknown as HeartbeatBody;
  const n = await heartbeatNativeNode(node.nodeId, body.telemetry ?? ({} as HeartbeatBody["telemetry"]), body.capabilities, body.draining);
  if (n.benchmark.basis === "unmeasured" || (n.benchmark.at != null && Date.now() - n.benchmark.at > BENCHMARK_TTL_MS)) await scheduleBenchmark(n.nodeId);
  else await scheduleCanary(n.nodeId);
  const imports = await importedSpecsForWire();
  const pull = n.reported.capabilities.imports ? importOffersFor(n, await listImportedModels().catch(() => [])) : [];
  return json({ state: n.state, serverTime: Date.now(), ...(n.banReason ? { instruction: "stop" } : {}), imports, ...(pull.length ? { pull } : {}) });
});
