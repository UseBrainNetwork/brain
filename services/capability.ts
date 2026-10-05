import type { CapabilityLevel, CapabilityState, NetworkCapability } from "@/domain/economy";
import { networkConfig } from "@/lib/config";
import { providerStats } from "@/engine/metrics";
import { listJobs } from "./distributed";
import { liveNodes } from "./nodes";

/**
 * What the network can do RIGHT NOW, derived only from real nodes and real job history.
 * A capability is AVAILABLE only when the network has actually demonstrated it recently.
 */

interface Def {
  id: string;
  label: string;
  description: string;
  minNodes: number;
  /** Minimum verified compute score per compatible node. */
  minScore: number;
  /** Sum of compute scores across compatible nodes. */
  minCapacity: number;
  /** The workload class whose recent success rate is evidence. null = no evidence possible yet. */
  evidenceSize: "small" | "medium" | "large" | null;
  experimental?: boolean;
}

const DEFS: Def[] = [
  { id: "matmul-small", label: "Parallel integer matmul · small", description: "512³ u32 work units, spot-check verified", minNodes: 1, minScore: 1_000, minCapacity: 1_000, evidenceSize: "small" },
  { id: "matmul-medium", label: "Parallel integer matmul · medium", description: "1024×1024×512 u32 work units", minNodes: 2, minScore: 2_000, minCapacity: 8_000, evidenceSize: "medium" },
  { id: "matmul-large", label: "Parallel integer matmul · large", description: "1024³ u32 work units", minNodes: 3, minScore: 4_000, minCapacity: 20_000, evidenceSize: "large" },
  { id: "redundant-verification", label: "Redundant execution (2× replicas)", description: "Every unit computed by two nodes and cross-checked", minNodes: 2, minScore: 1_000, minCapacity: 2_000, evidenceSize: null },
  { id: "embeddings", label: "Embeddings on browser nodes", description: "Requires a WebGPU embedding kernel and model weights distribution", minNodes: 4, minScore: 8_000, minCapacity: 60_000, evidenceSize: null, experimental: true },
  { id: "llm-inference", label: "Distributed LLM inference", description: "Layer-sharded transformer decoding across browser nodes", minNodes: 8, minScore: 15_000, minCapacity: 200_000, evidenceSize: null, experimental: true },
];

const fmt = (n: number) => n.toLocaleString("en-US");

export async function assessCapabilities(): Promise<{ capabilities: NetworkCapability[]; levels: CapabilityLevel[]; nodes: number; capacityScore: number }> {
  const nodes = await liveNodes();
  const jobs = await listJobs(100);
  const since = Date.now() - 6 * 60 * 60_000;
  const recent = jobs.filter((j) => j.createdAt > since && (j.status === "completed" || j.status === "failed"));
  const capacityScore = nodes.reduce((s, n) => s + n.computeScore, 0);

  const capabilities: NetworkCapability[] = DEFS.map((d) => {
    const compatible = nodes.filter((n) => n.computeScore >= d.minScore);
    const cap = compatible.reduce((s, n) => s + n.computeScore, 0);
    const ev = d.evidenceSize ? recent.filter((j) => j.size === d.evidenceSize) : [];
    const okRate = ev.length ? ev.filter((j) => j.status === "completed").length / ev.length : null;
    const requirements = [
      { label: "Compatible nodes online", required: `≥ ${d.minNodes}`, current: String(compatible.length), met: compatible.length >= d.minNodes },
      { label: "Per-node verified score", required: `≥ ${fmt(d.minScore)}`, current: compatible.length ? `${fmt(Math.min(...compatible.map((n) => n.computeScore)))} (min)` : "—", met: compatible.length > 0 },
      { label: "Aggregate capacity", required: `≥ ${fmt(d.minCapacity)}`, current: fmt(cap), met: cap >= d.minCapacity },
      ...(d.evidenceSize ? [{ label: "Recent success rate (6h)", required: "≥ 90% over ≥ 1 job", current: okRate == null ? "no jobs yet" : `${(okRate * 100).toFixed(0)}% over ${ev.length}`, met: okRate != null && okRate >= 0.9 }] : []),
      ...(d.experimental ? [{ label: "Kernel implemented", required: "yes", current: "no", met: false }] : []),
    ];
    const reasons: string[] = [];
    let state: CapabilityState;
    if (d.experimental) {
      state = "EXPERIMENTAL";
      reasons.push("not implemented; shown so the requirement path is visible");
    } else if (!requirements[0].met || !requirements[2].met) {
      state = "UNAVAILABLE";
      reasons.push(!requirements[0].met ? `${compatible.length}/${d.minNodes} compatible nodes online` : `capacity ${fmt(cap)} below ${fmt(d.minCapacity)}`);
    } else if (d.evidenceSize && okRate == null) {
      state = "LIMITED";
      reasons.push("capacity present but no recent job has demonstrated it");
    } else if (d.evidenceSize && okRate != null && okRate < 0.9) {
      state = "LIMITED";
      reasons.push(`recent success rate ${(okRate * 100).toFixed(0)}%`);
    } else {
      state = "AVAILABLE";
      reasons.push(d.evidenceSize ? `${ev.length} recent job${ev.length === 1 ? "" : "s"} succeeded` : "requirements met");
    }
    return { id: d.id, label: d.label, description: d.description, state, reasons, requirements, evidence: { compatibleNodes: compatible.length, recentSuccessRate: okRate, recentJobs: ev.length, capacityScore: cap } };
  });

  // Capabilities served by upstream providers (chat, embeddings). State comes from configuration
  // and measured requests on this server; "configured" is never presented as "demonstrated".
  const env = process.env;
  const upstream = async (id: string, label: string, description: string, configured: boolean, providerId: "cloud-fallback" | "external", envHint: string): Promise<NetworkCapability> => {
    const st = configured ? await providerStats(providerId) : { samples: 0, reliability: null as number | null, medianLatencyMs: null as number | null, lastError: undefined as string | undefined };
    const requirements = [
      { label: "Provider configured", required: envHint, current: configured ? "yes" : "no", met: configured },
      { label: "Measured requests", required: "≥ 1", current: String(st.samples), met: st.samples > 0 },
      { label: "Measured reliability", required: "≥ 90%", current: st.reliability == null ? "no data" : `${(st.reliability * 100).toFixed(0)}%`, met: st.reliability != null && st.reliability >= 0.9 },
    ];
    let state: CapabilityState;
    const reasons: string[] = [];
    if (!configured) {
      state = "UNAVAILABLE";
      reasons.push("no provider configured on this server");
    } else if (st.samples === 0) {
      state = "LIMITED";
      reasons.push("configured but no request has been measured yet");
    } else if (st.reliability != null && st.reliability < 0.9) {
      state = "LIMITED";
      reasons.push(`measured reliability ${(st.reliability * 100).toFixed(0)}%${st.lastError ? ` · last error ${st.lastError}` : ""}`);
    } else {
      state = "AVAILABLE";
      reasons.push(`${st.samples} measured request${st.samples === 1 ? "" : "s"}${st.medianLatencyMs != null ? ` · median ${Math.round(st.medianLatencyMs)}ms` : ""}`);
    }
    return { id, label, description, state, reasons, requirements, evidence: { compatibleNodes: 0, recentSuccessRate: st.reliability, recentJobs: st.samples, capacityScore: 0 } };
  };
  const extConfigured = Boolean(env.BRAIN_EXTERNAL_BASE_URL && env.BRAIN_EXTERNAL_API_KEY && env.BRAIN_EXTERNAL_MODEL);
  const cloudConfigured = Boolean(env.BRAIN_FALLBACK_BASE_URL && env.BRAIN_FALLBACK_API_KEY && env.BRAIN_FALLBACK_MODEL);
  capabilities.push(
    await upstream("chat-external", "Chat via external model", `OpenAI-compatible upstream${env.BRAIN_EXTERNAL_MODEL ? ` · ${env.BRAIN_EXTERNAL_MODEL}` : ""}; receipts unverified-provider-response`, extConfigured, "external", "BRAIN_EXTERNAL_*"),
    await upstream("chat-cloud", "Chat via operator cloud GPU", "Operator-controlled inference; required for PRIVATE routing", cloudConfigured, "cloud-fallback", "BRAIN_FALLBACK_*"),
    {
      id: "embeddings-external",
      label: "Embeddings via external model",
      description: "Passthrough to the external provider's embeddings endpoint; unpriced",
      state: env.BRAIN_EXTERNAL_EMBED_MODEL && extConfigured ? "LIMITED" : "UNAVAILABLE",
      reasons: [env.BRAIN_EXTERNAL_EMBED_MODEL && extConfigured ? "configured; usage is recorded but no receipt or price is issued" : "BRAIN_EXTERNAL_EMBED_MODEL not configured"],
      requirements: [{ label: "Embedding model configured", required: "BRAIN_EXTERNAL_EMBED_MODEL", current: env.BRAIN_EXTERNAL_EMBED_MODEL ? "yes" : "no", met: Boolean(env.BRAIN_EXTERNAL_EMBED_MODEL) }],
      evidence: { compatibleNodes: 0, recentSuccessRate: null, recentJobs: 0, capacityScore: 0 },
    },
  );

  const completed = jobs.filter((j) => j.status === "completed");
  const verifiedUnits = completed.reduce((s, j) => s + j.totals.verified, 0);
  const maxNodesInJob = Math.max(0, ...completed.map((j) => j.totals.nodesUsed));
  const levelDefs = [
    { level: 1, label: "Single real node, verified work", req: [{ label: "Real nodes online", required: "≥ 1", cur: nodes.length, need: 1 }, { label: "Verified work units (all time)", required: "≥ 1", cur: verifiedUnits, need: 1 }] },
    { level: 2, label: "Multi-node parallel execution", req: [{ label: "Nodes used in one job", required: "≥ 3", cur: maxNodesInJob, need: 3 }, { label: "Completed jobs", required: "≥ 5", cur: completed.length, need: 5 }] },
    { level: 3, label: "Resilient network", req: [{ label: "Real nodes online", required: "≥ 5", cur: nodes.length, need: 5 }, { label: "Verified work units", required: "≥ 500", cur: verifiedUnits, need: 500 }, { label: "Jobs with reassignment that still completed", required: "≥ 1", cur: completed.filter((j) => j.totals.reassigned > 0).length, need: 1 }] },
    { level: 4, label: "Priced compute", req: [{ label: "Real nodes online", required: "≥ 10", cur: nodes.length, need: 10 }, { label: "Aggregate capacity", required: "≥ 150,000", cur: capacityScore, need: 150_000 }, { label: "Receipts with a customer price", required: "≥ 1", cur: completed.filter((j) => j.orderId).length, need: 1 }] },
    { level: 5, label: "Distributed inference", req: [{ label: "Real nodes online", required: "≥ 25", cur: nodes.length, need: 25 }, { label: "LLM kernel", required: "implemented", cur: 0, need: 1 }] },
  ];
  const levels: CapabilityLevel[] = levelDefs.map((l) => {
    const requirements = l.req.map((r) => ({ label: r.label, required: r.required, current: fmt(r.cur), met: r.cur >= r.need }));
    return { level: l.level, label: l.label, reached: requirements.every((r) => r.met), requirements };
  });
  return { capabilities, levels, nodes: nodes.length, capacityScore };
}

export const capabilityConfig = { heartbeatMs: networkConfig.nodes.heartbeatMs };
