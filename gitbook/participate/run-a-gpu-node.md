# Run a GPU node

For any machine with a GPU: NVIDIA, AMD or Apple silicon. The agent is outbound-only, opens no ports, and never runs anything a request asked for; it drives an inference engine on your machine over loopback.

Two ways to run the engine:

* **vLLM, managed by the agent** (NVIDIA + Linux + Docker). The agent pulls a pinned image and runs it in an isolated container. Fastest path on NVIDIA.
* **A local server you run yourself** (any GPU, any OS): [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server`, [Ollama](https://ollama.com), [mlx-lm](https://github.com/ml-explore/mlx-lm) on Apple silicon, or an [exo](https://github.com/exo-explore/exo) cluster. All speak the OpenAI API; the agent reads the server's model list, maps it onto the [allowlist](https://brainnetwork.app/models) by name, and serves only what matches.

## Requirements

* A GPU. NVIDIA (`nvidia-smi`), AMD on Linux (`rocm-smi`) and Apple silicon are detected and reported; anything else still works through a local server, it just shows no GPU details.
* Node.js 20 or later.
* For vLLM mode: Docker with the NVIDIA container toolkit and ~10 GB for the image.
* Model weights: 1 to 15 GB depending on the model.
* Any internet connection that allows outbound HTTPS. No port forwarding.

## Install and run

```bash
git clone https://github.com/UseBrainNetwork/brain && cd brain && npm install
```

**NVIDIA with Docker** (vLLM, managed for you):

```bash
npm run node
```

First start pulls the vLLM image and the weights for every allowlisted model your reported VRAM fits; the agent prints progress.

**Ollama** (NVIDIA, AMD, Apple; Linux, macOS, Windows):

```bash
ollama serve                       # in another terminal, if it is not already running
ollama pull qwen2.5:1.5b-instruct  # or let the agent pull it on first use
BRAIN_NODE_MODE=ollama BRAIN_NODE_MODELS=qwen/qwen2.5-1.5b-instruct npm run node
```

**llama.cpp** (any GPU: CUDA, ROCm, Metal, Vulkan):

```bash
llama-server -m Qwen2.5-1.5B-Instruct-Q4_K_M.gguf --alias qwen2.5-1.5b-instruct --port 8080 -ngl 99
BRAIN_NODE_MODE=llamacpp npm run node
```

**mlx-lm** (Apple silicon):

```bash
pip install mlx-lm
mlx_lm.server --model mlx-community/Qwen2.5-7B-Instruct-4bit --port 8080
BRAIN_NODE_MODE=mlx npm run node
```

**exo** (several Macs or PCs as one node): start exo on the cluster, then `BRAIN_NODE_MODE=exo BRAIN_NODE_BACKEND_URL=http://<exo-host>:52415 npm run node`.

In every mode the agent registers with the coordinator, prints which allowlisted models it will serve, and heartbeats every 15 seconds. If the served name does not map onto an allowlisted id by itself, pin it: `BRAIN_NODE_MODEL_MAP="qwen/qwen2.5-3b-instruct=my-quant"`.

AMD and Ollama support started as a community fork by [chricc](https://github.com/chricc/brain), tested on an RX 9070 XT.

Without a GPU, for development only:

```bash
BRAIN_NODE_MODE=mock npm run node
```

A mock node may only serve `brain/mock`, says so in every token, and is refused by the production coordinator unless the operator allows it.

## Configuration

| Variable | Effect |
| --- | --- |
| `BRAIN_COORDINATOR_URL` | Coordinator to join (default `https://brainnetwork.app`) |
| `BRAIN_NODE_MODE` | `vllm`, `llamacpp`, `ollama`, `mlx`, `exo` or `mock` (auto: vllm when `nvidia-smi` is present, else mock) |
| `BRAIN_NODE_BACKEND_URL` | Base URL of your local server (defaults: llama.cpp/mlx `:8080`, Ollama `:11434`, exo `:52415`) |
| `BRAIN_NODE_MODELS` | Comma-separated subset of the allowlist to serve |
| `BRAIN_NODE_MODEL_MAP` | Pin allowlisted id → served name, e.g. `qwen/qwen2.5-3b-instruct=my-quant` |
| `BRAIN_NODE_REGION` | Label shown to developers, e.g. `eu-north` |
| `BRAIN_NODE_CONCURRENCY` | Parallel jobs, 1 to 16 |
| `BRAIN_NODE_ASK_USD_PER_1M` | Optional ask price per 1M tokens; the price term of the routing score |
| `BRAIN_NODE_WALLET` | Solana address to be paid |
| `BRAIN_NODE_HOME` | Where `identity.json` lives (default `~/.brain-node`) |
| `HF_TOKEN` | For gated model repositories |

## What happens next

1. Your node appears on [/network](https://brainnetwork.app/network) within one heartbeat, with your hardware labelled **REPORTED**.
2. The coordinator sends a pinned benchmark job and times it. Decode tokens per second on its clock becomes your score and compute class. This earns nothing.
3. Once benchmarked, you are eligible for customer work. The router scores you on measured speed, free slots, heartbeat round trip, reliability and ask.
4. Canaries arrive hourly and every 25 jobs. Two consecutive failures mark you `DEGRADED` until one passes.
5. About 5 % of your deterministic jobs are re-run on another node and compared. A mismatch counts against both of you.

## Pinning a model

A customer request that names a model only ever reaches a node serving that model, so which models you pin decides which traffic you compete for. [/models](https://brainnetwork.app/models) shows, per allowlisted model, nodes online, measured speed, lowest ask, and the last 24 hours of orders that asked for it, were served, or went unserved because no node could take them. A model marked **wanted** had customers and no supply.

```bash
# vLLM (NVIDIA): the agent pulls and serves the pinned ids. Multi-GPU boxes are sharded
# automatically when a model's floor exceeds one card.
BRAIN_NODE_MODE=vllm BRAIN_NODE_MODELS=qwen/qwen2.5-32b-instruct-awq npm run node

# Ollama / llama.cpp / mlx-lm / exo: you serve the weights, the agent advertises what matches.
ollama pull qwen2.5:32b-instruct
BRAIN_NODE_MODE=ollama BRAIN_NODE_MODELS=qwen/qwen2.5-32b-instruct npm run node
```

Plain ids (`qwen/qwen2.5-32b-instruct`) mean the model at whatever precision your server runs; `-awq` ids are the vLLM 4-bit builds with their own VRAM floor. The allowlist includes 14B, 32B, Coder 32B and 72B Qwen2.5, DeepSeek R1 distills (8B, 32B) and Llama 3.3 70B; see the full list with VRAM floors and licenses on `/models`. Units for the hourly epoch scale with parameters × tokens, so a served 32B request counts about twenty times a 1.5B one.

## Getting paid

Set `BRAIN_NODE_WALLET`, then open `/provider?node=<your id>` and sign once with that wallet. The coordinator links the wallet only when the signature and the node's own report name the same address. From then on every completed customer inference job becomes verified work in the hourly SOL epoch, with units `parameters × tokens ÷ 2²⁰` clipped to what the coordinator streamed. Claim on [/rewards](https://brainnetwork.app/rewards) like any contributor.

Until the wallet is linked, your work is recorded and visible on `/provider` but earns nothing.

## Watching your node

`/provider?node=<id>` shows state, reported GPU, load, VRAM, current model, jobs today, uptime, reliability, compute class, accrued versus settled USD earnings, heartbeat sparklines, and speed per job. The API's `brain-node-id` header on every response you serve lets a developer find the same page.

## What the first operators learned

The first three real nodes joined on 7 October 2026. The RTX 3050 laptop's vLLM returned `500 internal_error` on a run of canaries and went `DEGRADED` as designed; the 3060 and 3050 dropped off during the day's database outage and were marked `OFFLINE` at 45 seconds without a heartbeat. The 4060 stayed up and was serving at 64.8 tokens per second when this was written. Nothing about those events was hidden; they are on `/network` and in the job history.
