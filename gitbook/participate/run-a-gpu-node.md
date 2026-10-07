# Run a GPU node

For machines with an NVIDIA card. The agent is outbound-only, opens no ports, and runs models in an isolated container.

## Requirements

* NVIDIA GPU with a working driver (`nvidia-smi` prints your card).
* Docker with the NVIDIA container toolkit.
* Node.js 20 or later.
* Disk for the vLLM image (about 10 GB) plus model weights (1 to 15 GB depending on the model).
* Any internet connection that allows outbound HTTPS. No port forwarding.

## Install and run

```bash
git clone https://github.com/UseBrainNetwork/brain && cd brain && npm install
npm run node
```

First start pulls the vLLM image and the weights for every allowlisted model your reported VRAM fits; the agent prints progress. Then it registers with the coordinator, loads its first model in the background, and heartbeats every 15 seconds.

Without a GPU, for development only:

```bash
BRAIN_NODE_MODE=mock npm run node
```

A mock node may only serve `brain/mock`, says so in every token, and is refused by the production coordinator unless the operator allows it.

## Configuration

| Variable | Effect |
| --- | --- |
| `BRAIN_COORDINATOR_URL` | Coordinator to join (default `https://brainnetwork.app`) |
| `BRAIN_NODE_MODE` | `vllm` or `mock` (auto: vllm when `nvidia-smi` is present) |
| `BRAIN_NODE_MODELS` | Comma-separated subset of the allowlist to serve |
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

## Getting paid

Set `BRAIN_NODE_WALLET`, then open `/provider?node=<your id>` and sign once with that wallet. The coordinator links the wallet only when the signature and the node's own report name the same address. From then on every completed customer inference job becomes verified work in the hourly SOL epoch, with units `parameters × tokens ÷ 2²⁰` clipped to what the coordinator streamed. Claim on [/rewards](https://brainnetwork.app/rewards) like any contributor.

Until the wallet is linked, your work is recorded and visible on `/provider` but earns nothing.

## Watching your node

`/provider?node=<id>` shows state, reported GPU, load, VRAM, current model, jobs today, uptime, reliability, compute class, accrued versus settled USD earnings, heartbeat sparklines, and speed per job. The API's `brain-node-id` header on every response you serve lets a developer find the same page.

## What the first operators learned

The first three real nodes joined on 7 October 2026. The RTX 3050 laptop's vLLM returned `500 internal_error` on a run of canaries and went `DEGRADED` as designed; the 3060 and 3050 dropped off during the day's database outage and were marked `OFFLINE` at 45 seconds without a heartbeat. The 4060 stayed up and was serving at 64.8 tokens per second when this was written. Nothing about those events was hidden; they are on `/network` and in the job history.
