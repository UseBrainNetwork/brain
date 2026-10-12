# Turning compute into premium models

Design and engineering spec. How BRAIN converts the compute it aggregates into models and model tiers that are worth paying for, how it pools nodes to serve models no single contributor can hold, and where the paying work comes from. Companion to `ARCHITECTURE.md` (what exists), `ECONOMICS.md` (how money moves) and `PHASE_3.md` (the earlier critical path).

Ground rules carried over from `REAL_VS_SIMULATED.md` and the project constraints: no foundation model pretraining; no economics that are not measured; unverified work earns nothing; every number we publish about a model comes from a receipt-backed run on this network.

## 0. Where we stand (12 Oct 2026)

| | Measured |
| --- | --- |
| Browser nodes online | 16 (2,777 on 10 Oct, 54 % behind one IP; left when claims paused) |
| Native GPU nodes online | 0 of 5 registered |
| API requests, last 24 h | 0 |
| Network inference served, last 7 d | 7 requests, one model (1.5B), p50 2.4 s |
| Inference relay | not deployed, so the browser inference tier serves nothing |
| Largest model a single contributor has served | Qwen2.5 7B AWQ |

The gateway, receipts, policy, payments and private tier are ahead of the supply they route. Render's position comes from having both sides of the market. This spec is about building the supply that is worth buying and the product that is worth paying for, in that order, with each step measurable.

## 1. The thesis

A GPU in a bedroom running a 7B model is not a product; OpenRouter lists forty of those. Three things a crowd of GPUs can do that a single provider cannot, or will not, are:

1. **Pool** many mid-size GPUs into one large model (70B–405B class) and prove, per request, which machines ran it.
2. **Spend** otherwise idle compute on more inference per answer (candidates, verification, search) and sell the measured quality lift as a tier.
3. **Shape** open models into BRAIN-owned variants using the network's own traffic and compute, through adapter training, not pretraining, and serve them only here.

Each is a way of turning compute units into a thing a buyer pays more for than the raw tokens cost. Each produces a receipt that shows the work. The sections below specify them in build order.

## 2. Pooled serving: one model across several nodes

### 2.1 Goal

Serve `meta-llama/llama-3.3-70b-instruct` and `qwen/qwen2.5-72b-instruct` on contributor hardware where no contributor has 40+ GB of VRAM. Later the 405B class. The customer sees one model id; the receipt lists every node and its layer range.

### 2.2 What exists

- Node agent with vLLM backend (`node/src/backends/vllm.ts`), tensor-parallel across the GPUs inside one machine (`--tensor-parallel-size` auto when `minVramMb > perGpu`).
- Generic OpenAI-compatible local backend covering llama.cpp, Ollama, mlx-lm and exo (`node/src/backends/local.ts`).
- Browser pipeline parallelism over the Cloudflare relay with two-replica verification (`services/inference.ts`, `relay/`), proven on Qwen3 0.6B–4B.
- Coordinator job model with signed per-hop reports, deadlines and reassignment (`services/coordinator/jobs.ts`).

### 2.3 Two mechanisms, chosen per pool

**A. Operator-local pools (ship first).** One operator, several machines on one LAN. llama.cpp's RPC backend and exo already do pipeline/tensor split over a LAN with sub-millisecond hops. The node agent gains a `pool` mode: one agent is the head, declares `poolMembers` in its capabilities, and the coordinator treats the pool as one node with the summed VRAM. The head runs the backend process (`llama-server --rpc host1:port,host2:port` or exo's cluster) and reports the member list and per-member hardware so the receipt can name them. No new transport. Verification is the existing canary + shadow-replay path at the pool level, plus a new **member attestation**: each member runs the agent's hardware probe and signs a report the head forwards; a pool claiming four 4090s has four signed probes or it is `unmeasured` and not routable.

**B. Cross-operator pools (second).** Strangers' GPUs across the internet. Pipeline parallel only (tensor parallel needs per-layer all-reduce; across the internet that is tens of ms per layer and unusable). Hop cost is the relay round trip, 30–60 ms, so a 70B in 8 stages decodes at roughly 8–15 tok/s for one sequence, which is acceptable for batch and tolerable for chat. Mechanism: the browser relay protocol generalised to native nodes. A native stage is a llama.cpp or vLLM process loading a layer range (`--override-tensor`/custom loader) and exposing `forward(hidden, kv_session)`; the relay already moves f16 hidden states and pairs replicas. KV cache per session lives on each stage, as it does in the browser tier. Verification: every stage runs on two nodes where supply allows and hidden states must agree within tolerance; the final stage returns top-k logits compared the same way. A stage without a replica is `no-replica` and earns nothing, same rule as today.

### 2.4 Scheduling

- A new allocator `services/pools.ts` assigns `(model, stage)` to nodes by VRAM, measured bandwidth to the relay, and reputation. Fill order: hold a full replica-checked pipeline for the most demanded model (`/api/models/demand`) before adding capacity for a second model.
- Stage weights come from the Hugging Face CDN by range request, same loader design as `inference/shardLoader.ts`, cached on disk by the agent.
- Session placement: a request picks the pipeline with the lowest sum of stage p50 latency over the last hour, not the newest nodes.
- Loss of a stage mid-session: the relay fails the lap, the gateway retries once on another pipeline (policy `retries`), the receipt records both attempts.

### 2.5 Receipt fields

`pool: { kind: "operator-local" | "cross-operator", stages: [{ stage, layers, nodes: [{ id, verified }] }], hopP50Ms, tokPerSec }`. Signed as part of the canonical body. The explorer renders it as the pipeline diagram the browser tier already has.

### 2.6 Acceptance

- A 70B served end-to-end on ≥ 2 contributor machines with every stage replica-checked, p50 decode ≥ 8 tok/s, receipts verifying.
- `/status` reports pooled models with p50/p95 and verification rate exactly as it does for single-node models.
- Zero verified compute → zero reward holds for every pool member (tested).

## 3. Test-time compute tier: `brain/pro`

### 3.1 Goal

Same open weights, more compute per answer, a measured quality lift, a receipt that shows the extra work. Priced as the compute it consumes. This is the first product that is better because the network is big, and the first paid use for idle small nodes.

### 3.2 Mechanism

For one request in `mode: "pro"`:

1. **Sample.** N candidates (default 4, max 8) from the routed model, temperature 0.7, in parallel on different nodes. Browser tabs and small native nodes are ideal: embarrassingly parallel, latency-tolerant.
2. **Verify.** By task class, detected from the request (`engine/router.ts` already classifies capabilities):
   - *Exact-answer* (math, short factual, classification): self-consistency vote on the normalised final answer.
   - *Code with tests* (the request includes tests or a `response_format` schema): execute candidates in the existing sandboxed runner path; first to pass wins; the receipt carries the pass/fail matrix.
   - *Open-ended*: a judge pass on the largest pooled model available scores candidates pairwise; the receipt names the judge model and node.
3. **Return** the winner in the normal OpenAI shape with `brain.pro: { n, agreement, verifier, candidateNodes, judge? }`.

### 3.3 Eval gate before it ships

`scripts/eval/` runs a fixed suite through `auto` and `pro` on the live network: GSM8K (200 items), HumanEval (164), a 200-item short-answer QA set, plus 100 open-ended prompts judged blind. Results, per model, are published on `/status` with the receipt ids that produced them. `pro` is enabled for a model only where the measured lift is positive and the confidence interval excludes zero. If it does not help, the page says so.

### 3.4 Pricing

List price × tokens actually generated across all candidates + judge tokens. Shown in the quote before the request runs (`x-brain-pay` already returns a quote; `pro` multiplies the budget by N). No "equivalent to model X" claims anywhere; the only claim is our measured delta on our suite.

### 3.5 Acceptance

- Measured positive lift on at least two models in the suite, published.
- A `pro` receipt verifies and names every candidate node, with per-candidate verification status.
- Idle-fleet utilisation during `pro` traffic visible on `/status`; operator-baseline filler pay can then be wound down (the policy decision parked as r8).

## 4. BRAIN-owned premium models: adapters, not pretraining

### 4.1 Goal

Models that exist only on this network and are measurably better for the work this network actually receives. Done by training LoRA/QLoRA adapters on open base models using (a) the network's own routed traffic, with consent, and (b) outputs of the pooled large models as teacher signal. Base weights stay open and credited; the adapter and the serving recipe are BRAIN's.

This is within the "no foundation model" rule: adapter training on a 7B is hours on consumer GPUs, not months on a cluster.

### 4.2 Data

- **Opt-in traffic.** `privacy: "standard"` requests gain an explicit `training: true` flag (default false). Only flagged requests are retained for training; the receipt records the flag. Private-tier and pay-per-call requests are never used.
- **Distillation.** Prompts from the demand log are answered by the pooled 70B class and by `brain/pro`; those pairs train the small model. Compute spent producing teacher outputs is paid as ordinary verified inference.
- **Rejection sampling.** `pro`'s verifier already labels candidates right/wrong; those labels are free training signal.

### 4.3 Training on the network

A new job kind `train` for native nodes: QLoRA on a 7B–14B base with 24 GB VRAM, data shards streamed from storage BRAIN controls, gradient checkpoints uploaded every N steps. Verification is the hard part and is specified, not hand-waved:

- **Redundant steps.** 10 % of training steps are issued to two nodes with identical seed, data shard and starting checkpoint; resulting adapter deltas must match within tolerance (bf16 non-determinism bounded by fixed kernels; tolerance measured in a calibration run and published). Mismatch marks both unverified and triggers a third run.
- **Held-out evaluation.** Every checkpoint is scored on a held-out set by nodes that did not train it. A checkpoint that does not improve the held-out metric earns nothing for its steps.
- **Final gate.** The adapter ships only if it beats the base model on the eval suite in §3.3 for the task class it targets, published with receipts.

Payment: verified training steps are compute units like any other. Unverified steps earn zero.

### 4.4 Serving and exclusivity

Adapters are served by the pooled/single-node tiers with `--lora-modules` (vLLM) or GGUF adapter merge (llama.cpp). Model id `brain/<name>-<base>-v<n>`. Adapter weights are distributed to nodes encrypted at rest and only to nodes with reputation above a threshold; a node receives the adapter for the duration it is routable. Exclusivity is operational, not cryptographic: a determined operator can extract an adapter from GPU memory. The defence is that the adapter is retrained continuously on fresh network traffic, so an extracted copy goes stale. State this plainly in the docs.

### 4.5 Acceptance

- First adapter: a code-task or structured-output specialist on Qwen2.5-7B, trained on distilled `pro` outputs, beating base on HumanEval/structured-output suite with a published delta.
- Training receipts on the explorer, with redundant-step verification visible.
- Licence compliance checked per base model (Llama community licence attribution; Qwen Apache-2.0).

## 5. Demand: where the paying work comes from

Supply with no buyers is the current state. These are the workloads a crowd of consumer GPUs is actually competitive for, in order of how fast each can start paying.

1. **Batch inference** (`POST /v1/batches`, OpenAI's shape). Thousands of prompts, results in hours, at a discount to list. Classification backfills, synthetic data, eval runs, dataset labelling. Latency-tolerant, parallel, exactly what a fleet of mixed GPUs does well. The scheduler fills idle nodes with batch items between interactive requests. Receipts per item; one signed manifest per batch.
2. **Model evals as a service.** The eval harness from §3.3 offered to anyone: give us a model id (or an adapter) and a suite, we run it across N nodes and return signed results. Teams evaluating open models want independent, reproducible numbers; a public leaderboard built from these runs is the discovery channel that Render's benchmarks were for them.
3. **Agent pay-per-call** (shipped). Reach agent frameworks via the integrations page; the differentiator is no account and a signed receipt per call.
4. **Private tier** (shipped). Companies with a compliance need and their own GPU: BRAIN runs the gateway, receipts and policy; their node runs the model. Sell to the operators we already have first.
5. **Pooled large models** (§2). Once a 70B serves reliably with receipts, the buyer is anyone who wants Llama 3.3 70B with a provable execution trail at a price set by the operators, not by us.

Pricing: operators' asks (`BRAIN_NODE_ASK_USD_PER_1M`) plus a published gateway margin. We do not set a price for capacity we do not have; a model with no routable node shows no price.

## 6. Build order and what each step needs

| # | Item | Depends on | Who |
| --- | --- | --- | --- |
| 0 | Deploy the inference relay (`relay/`, two Vercel vars) | Cloudflare account | operator |
| 1 | `brain/pro` sampling + verifiers + receipt fields | 0 for browser candidates; works on native/upstream without | engineering |
| 2 | Eval harness + `/status` publication; `pro` enabled per measured lift | 1 | engineering |
| 3 | `POST /v1/batches` with idle-fill scheduling | — | engineering |
| 4 | Operator-local pools (llama.cpp RPC / exo head mode, member attestation) | an operator with ≥ 2 machines | engineering + 1 operator |
| 5 | Evals as a service + public leaderboard from receipts | 2 | engineering |
| 6 | Cross-operator pools over the relay | 0, 4, ≥ 3 operators holding stages | engineering |
| 7 | `train` job kind, redundant-step verification, first adapter | 1, 2, 4 for teacher outputs | engineering |
| 8 | Wind down operator-baseline filler pay | 1 shipping real paid work to the fleet | operator decision |

Supabase tier upgrade and credential rotation remain prerequisites for any of this to hold under load.

## 7. What we will not do

- Pretrain a model. Adapters only, on credited open bases.
- Publish a quality number that did not come from a receipt-backed run on this network.
- Pay for training steps, candidates or pooled stages that were not verified.
- Mix a pooled, `pro` or adapter result with an upstream provider's output in one receipt without labelling each part.
- Claim exclusivity we cannot enforce; the adapter note in §4.4 says exactly what the protection is.
