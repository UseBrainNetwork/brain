import { Agent } from "./agent";
import { MockBackend } from "./backends/mock";
import type { InferenceBackend } from "./backends/types";
import { VllmBackend } from "./backends/vllm";
import { nvidiaSmi } from "./hardware";
import { loadIdentity } from "./identity";
import { HttpTransport } from "./transport";

/**
 * Brain Node entry point.
 *
 *   BRAIN_COORDINATOR_URL   coordinator base URL (default https://brainnetwork.app)
 *   BRAIN_NODE_MODE         mock | vllm   (default: vllm when an NVIDIA GPU is detected, else mock)
 *   BRAIN_NODE_MODELS       comma-separated allowlisted model ids to serve (vllm; default: all that fit)
 *   BRAIN_NODE_REGION       coarse region label, e.g. eu-west (optional)
 *   BRAIN_NODE_WALLET       Solana address for payouts (optional, verified later via /earn)
 *   BRAIN_NODE_CONCURRENCY  parallel jobs (default 1 mock, 4 vllm)
 *   BRAIN_NODE_ASK_USD_PER_1M  your ask per 1M output tokens (optional)
 *   BRAIN_NODE_HOME         identity directory (default ~/.brain-node)
 *   HF_TOKEN                forwarded to vLLM for gated models
 */
async function main() {
  const id = loadIdentity();
  const url = process.env.BRAIN_COORDINATOR_URL || "https://brainnetwork.app";
  const gpus = await nvidiaSmi();
  const mode = process.env.BRAIN_NODE_MODE || (gpus.length ? "vllm" : "mock");
  if (mode !== "mock" && mode !== "vllm") throw new Error(`BRAIN_NODE_MODE must be mock or vllm, got ${mode}`);
  const mock = mode === "mock";
  if (!mock && !gpus.length) throw new Error("BRAIN_NODE_MODE=vllm but nvidia-smi found no GPU. Use BRAIN_NODE_MODE=mock to run a simulated node.");
  const models = (process.env.BRAIN_NODE_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const backend: InferenceBackend = mock ? new MockBackend() : new VllmBackend({ gpus, models: models.length ? models : undefined, hfToken: process.env.HF_TOKEN, log: (l) => console.log(`${new Date().toISOString()} ${l}`) });
  const concurrency = Number(process.env.BRAIN_NODE_CONCURRENCY) || (mock ? 1 : 4);
  const ask = process.env.BRAIN_NODE_ASK_USD_PER_1M ? Number(process.env.BRAIN_NODE_ASK_USD_PER_1M) : null;

  console.log(`Brain Node ${id.nodeId} · ${mock ? "MOCK mode (simulated GPU, not a language model)" : `vLLM mode · ${gpus.map((g) => g.model).join(", ")}`} · coordinator ${url}`);
  const agent = new Agent(id, new HttpTransport(url, id), backend, {
    mock,
    region: process.env.BRAIN_NODE_REGION || null,
    wallet: process.env.BRAIN_NODE_WALLET,
    maxConcurrency: concurrency,
    askUsdPer1MTokens: ask != null && Number.isFinite(ask) ? ask : null,
    models: models.length ? models : undefined,
    agentVersion: "0.1.0",
  });
  const stop = () => void agent.stop().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await agent.run();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
