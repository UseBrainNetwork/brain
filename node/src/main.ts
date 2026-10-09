import { Agent } from "./agent";
import { DEFAULT_PORTS, LocalServerBackend } from "./backends/local";
import { MockBackend } from "./backends/mock";
import type { InferenceBackend } from "./backends/types";
import { VllmBackend } from "./backends/vllm";
import { detectGpus } from "./hardware";
import { loadIdentity } from "./identity";
import { HttpTransport } from "./transport";
import { isBackend, type Backend } from "../protocol";

/**
 * Brain Node entry point.
 *
 *   BRAIN_COORDINATOR_URL   coordinator base URL (default https://brainnetwork.app)
 *   BRAIN_NODE_MODE         mock | vllm | llamacpp | ollama | mlx | exo
 *                           default: vllm when an NVIDIA GPU is detected, else mock.
 *                           vllm:  the agent runs vLLM in Docker (NVIDIA + Linux).
 *                           others: an OpenAI-compatible server you already run on this machine
 *                           (llama.cpp llama-server, Ollama, mlx-lm, exo). Any GPU, any OS.
 *   BRAIN_NODE_BACKEND_URL  that server's base URL (default http://127.0.0.1:<engine default port>)
 *   BRAIN_NODE_MODELS       comma-separated allowlisted model ids to serve (default: all that fit / are served)
 *   BRAIN_NODE_MODEL_MAP    pin served names: "qwen/qwen2.5-1.5b-instruct=qwen2.5:1.5b-instruct,..."
 *   BRAIN_NODE_REGION       coarse region label, e.g. eu-west (optional)
 *   BRAIN_NODE_WALLET       Solana address for payouts (optional, verified later via /earn)
 *   BRAIN_NODE_CONCURRENCY  parallel jobs (default 1 mock, 4 vllm, 2 local servers)
 *   BRAIN_NODE_ASK_USD_PER_1M  your ask per 1M output tokens (optional)
 *   BRAIN_NODE_HOME         identity directory (default ~/.brain-node)
 *   HF_TOKEN                forwarded to vLLM for gated models
 */
const log = (l: string) => console.log(`${new Date().toISOString()} ${l}`);

function parseModelMap(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (s ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

async function main() {
  const id = loadIdentity();
  const url = process.env.BRAIN_COORDINATOR_URL || "https://brainnetwork.app";
  const gpus = await detectGpus();
  const nvidia = gpus.filter((g) => g.source === "nvidia-smi");
  const mode = process.env.BRAIN_NODE_MODE || (nvidia.length ? "vllm" : "mock");
  if (!isBackend(mode)) throw new Error(`BRAIN_NODE_MODE must be one of mock, vllm, llamacpp, ollama, mlx, exo; got ${mode}`);
  const kind: Backend = mode;
  const mock = kind === "mock";
  if (kind === "vllm" && !nvidia.length) throw new Error("BRAIN_NODE_MODE=vllm needs an NVIDIA GPU (nvidia-smi). For AMD or Apple silicon run llama.cpp, Ollama or mlx-lm and set BRAIN_NODE_MODE accordingly; BRAIN_NODE_MODE=mock runs a simulated node.");
  const models = (process.env.BRAIN_NODE_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  let backend: InferenceBackend;
  if (mock) backend = new MockBackend();
  else if (kind === "vllm") backend = new VllmBackend({ gpus: nvidia, models: models.length ? models : undefined, hfToken: process.env.HF_TOKEN, log });
  else {
    const local = new LocalServerBackend({ kind, baseUrl: process.env.BRAIN_NODE_BACKEND_URL || `http://127.0.0.1:${DEFAULT_PORTS[kind]}`, models: models.length ? models : undefined, modelMap: parseModelMap(process.env.BRAIN_NODE_MODEL_MAP), log });
    const served = await local.discover();
    if (!served.length) throw new Error(`${kind}: no allowlisted model is served at ${process.env.BRAIN_NODE_BACKEND_URL || `http://127.0.0.1:${DEFAULT_PORTS[kind]}`}. Start the server with one of the models on /models (see node/README.md), or pin a name with BRAIN_NODE_MODEL_MAP.`);
    log(`${kind}: serving ${served.join(", ")}`);
    backend = local;
  }
  const concurrency = Number(process.env.BRAIN_NODE_CONCURRENCY) || (mock ? 1 : kind === "vllm" ? 4 : 2);
  const ask = process.env.BRAIN_NODE_ASK_USD_PER_1M ? Number(process.env.BRAIN_NODE_ASK_USD_PER_1M) : null;

  const hw = gpus.length ? gpus.map((g) => g.model).join(", ") : "no GPU detected";
  console.log(`Brain Node ${id.nodeId} · ${mock ? "MOCK mode (simulated GPU, not a language model)" : `${kind} mode · ${hw}`} · coordinator ${url}`);
  const agent = new Agent(id, new HttpTransport(url, id), backend, {
    mock,
    region: process.env.BRAIN_NODE_REGION || null,
    wallet: process.env.BRAIN_NODE_WALLET,
    maxConcurrency: concurrency,
    askUsdPer1MTokens: ask != null && Number.isFinite(ask) ? ask : null,
    models: models.length ? models : undefined,
    agentVersion: "0.2.0",
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
