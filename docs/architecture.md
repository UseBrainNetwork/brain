# BRAIN architecture

BRAIN is a compute layer: people run Brain Nodes (supply), developers and agents send OpenAI-compatible requests (demand), and a coordinator routes each request to a node, times it, and issues a signed receipt.

Every component below carries one of three labels. The labels are the contract with the reader; a component is not promoted until the code and tests exist.

| Label | Meaning |
| --- | --- |
| **LIVE** | Deployed in production and exercised by tests. Numbers it produces come from real records. |
| **DEMO** | Works end to end but on a labelled mock (mock node, mock backend, `brain/mock` model). Never mixed with LIVE figures. |
| **PLANNED** | An interface or a stub exists so the shape is visible; it does nothing yet. |

## Diagram

```mermaid
flowchart LR
  subgraph demand [Demand]
    dev[Developer / agent<br/>OpenAI SDK]
    chat[/chat + /auto]
  end

  subgraph gateway [Gateway · LIVE]
    v1["/v1/chat/completions<br/>/v1/models<br/>API keys · rate limits · size limits"]
    auto["BRAIN AUTO router<br/>engine/router.ts<br/>capability · privacy · budget → score"]
  end

  subgraph coordinator [Coordinator · LIVE on serverless]
    reg["Node registry<br/>services/coordinator/registry.ts<br/>ONLINE · BUSY · DRAINING · DEGRADED · OFFLINE"]
    nrouter["Node router<br/>services/router/score.ts<br/>capability·availability·latency·reputation·price"]
    jobs["Job state machine<br/>services/coordinator/jobs.ts<br/>QUEUED→MATCHING→ASSIGNED→STARTING→RUNNING→VERIFYING→COMPLETED"]
    bench["Benchmark on join<br/>services/coordinator/benchmark.ts"]
    rcpt["Signed receipts<br/>services/coordinator/receipts.ts<br/>ed25519 over canonical body"]
    ledger["Accounting ledger<br/>services/accounting.ts"]
  end

  subgraph store [Store · LIVE]
    pg[(Postgres<br/>or MemoryStore)]
  end

  subgraph supply [Supply]
    agent["Brain Node agent · node/<br/>ed25519 identity · signed outbound HTTP<br/>nvidia-smi hardware report · heartbeat"]
    vllm["vLLM backend · Docker<br/>allowlisted models only"]
    mock["Mock backend<br/>brain/mock only · DEMO"]
    browser["Browser WebGPU nodes<br/>services/nodes.ts · LIVE"]
  end

  subgraph other [Other targets · LIVE when configured]
    cloud[CLOUD_GPU<br/>operator vLLM]
    ext[EXTERNAL_MODEL<br/>OpenAI-compatible upstream]
  end

  dev --> v1 --> auto
  chat --> auto
  auto -->|NATIVE_NETWORK| jobs
  auto --> cloud
  auto --> ext
  auto -->|BROWSER_NETWORK| browser
  jobs --> nrouter --> reg
  agent -->|register · heartbeat · long-poll work| reg
  agent -->|started · progress · completed · failed| jobs
  agent --> vllm
  agent --> mock
  reg --> bench --> jobs
  jobs -->|COMPLETED| rcpt --> ledger
  reg --> pg
  jobs --> pg
  rcpt --> pg
  ledger --> pg
  rcpt -.->|anchor hash · PLANNED| sol[(Solana)]
  ledger -.->|settlement · PLANNED| sol
```

## Components

### Gateway — LIVE

`app/api/v1/*`, `api/gateway.ts`. Validates the OpenAI request shape, authenticates API keys (`brain_sk_…`, stored as sha256), applies per-IP rate limits and prompt size limits, and hands the request to BRAIN AUTO. Responses carry `brain-request-id`, `brain-target`, `brain-latency`, `x-brain-receipt`, and when a Brain Node produced the answer `brain-node-id` and `brain-region` (`api/brainHeaders.ts`). `/v1/models` lists `brain/*` modes plus every allowlisted node model with its live node count.

### BRAIN AUTO — LIVE

`engine/router.ts`, `engine/providers.ts`, `engine/orders.ts`. Picks between resource classes: `BROWSER_NETWORK`, `NATIVE_NETWORK` (Brain Nodes), `CLOUD_GPU`, `EXTERNAL_MODEL`. Hard filters first (capability, privacy, budget), then a published weighted score. Unknown cost or latency stays UNKNOWN and is penalised, never guessed. The `NATIVE_NETWORK` provider (`engine/nativeProvider.ts`) estimates from the registry's measured speeds and executes by creating a job and observing it; an upstream never substitutes for a node model.

### Brain Node agent — LIVE (vLLM path untested on real hardware in CI; mock path DEMO)

`node/src/*`. Generates an ed25519 identity on first run (`identity.json`, mode 0600); node id = `N-` + 8 hex of sha256 over the public key. Detects hardware with `nvidia-smi` (model, VRAM, utilisation, temperature, power, driver, CUDA) or reports a labelled mock GPU. Every outbound request is signed over `method\npath\ntimestamp\nsha256(body)`. Outbound only: no inbound ports, no port forwarding. Heartbeats every 15 s with telemetry; long-polls `/api/coordinator/work` (≤20 s) for jobs. Transport is an interface (`node/src/transport.ts`); V1 ships HTTP long-poll because the coordinator runs serverless. WebSocket and QUIC are PLANNED behind the same interface.

Backends: `MockBackend` (DEMO) serves only `brain/mock` and says so in every token; `VllmBackend` runs the pinned `vllm/vllm-openai` image with `--cap-drop ALL`, `no-new-privileges`, loopback-only port, HF cache volume, and only models in `node/models.ts`. There is no path by which a request can run arbitrary code on a node.

### Coordinator — LIVE

`services/coordinator/*`, `app/api/coordinator/*`. Serverless Next.js routes over the shared store.

- **Registry.** Refuses mock nodes on a production coordinator unless `BRAIN_ALLOW_MOCK_NODES=1`. Stores what the node *reported* (hardware, capabilities, telemetry) separately from what the coordinator *measured* (jobs completed/failed/timed out, tokens, compute time, tok/s, time to first byte, uptime from heartbeats). State is derived server-side: `OFFLINE` after 45 s without a heartbeat (jobs re-queued), `DEGRADED` on no models / 3 consecutive failures of real work or canaries (failed benchmarks are recorded but do not degrade) / GPU ≥ 95 °C, `BUSY` when every slot is taken, `DRAINING` on the operator's flag. Real hardware that has not yet produced a coordinator-timed token (`benchmark.basis = unmeasured`) is never routed customer work: the router rejects it with `not yet benchmarked`; only the pinned benchmark probe may target it. A cold vLLM start gets 240 s (`coldStartWithinMs`) to load weights before its first job is given up on, and the agent loads its first model in the background right after registering. A mock node can never advertise a real model and a real node can never advertise `brain/mock`.
- **Node auth.** Signature verified against the key bound to the node id (trust on first use; a different key for a known id is refused), 60 s timestamp window, replay cache per instance.
- **Job state machine.** `QUEUED → MATCHING → ASSIGNED → STARTING → RUNNING → VERIFYING → COMPLETED`, plus `FAILED` and `CANCELLED`; illegal transitions throw. Every transition is appended to `history` with a timestamp and note. Timeouts: start within 20 s, no progress for 60 s, hard deadline. A node that reports `model_unavailable` before producing output is excluded and the job is re-queued once; a job whose node goes `OFFLINE` is re-queued immediately (or failed if it was already streaming).
- **Node router.** `services/router/score.ts` is pure and deterministic: hard filters (state, free slot, model, VRAM requirement, region, ask ≤ budget) with named rejections, then `0.30·capability + 0.25·availability + 0.15·latency + 0.20·reputation + 0.10·price`; unknowns score 0.5 with a note; ties break on node id. When nothing is eligible the result carries a sentence such as `0 of 3 nodes can serve qwen/qwen2.5-7b-instruct right now (N-1: VRAM 8 GB < 20 GB required; N-2: offline; …)`.
- **Verification (`node-reported`).** The coordinator checks the response hash the node sent against the text it received, that the streamed text equals the final text, token-count plausibility against output length, and wall time against its own clock. It does not re-execute every request, so receipts for node work say `verificationMethod: "node-reported"`, `verified: false`.
- **Verification probes — LIVE** (`services/coordinator/verify.ts`). Two coordinator-initiated, unpaid probes feed the reliability score:
  - *Sampled redundant execution.* `BRAIN_VERIFY_SAMPLE_RATE` (default 5%) of deterministic (temperature 0) customer jobs are re-run on a different node after completion. Outputs are compared with a text-similarity heuristic (character 4-gram Jaccard blended with length ratio, threshold 0.8) because bit-identical output across GPUs is unrealistic. A mismatch is recorded against both nodes; the coordinator cannot tell which one lied, so both lose confidence. The result is written to both jobs (`verification`) and shown on `/network`, `/provider` and in the API's `brain.node.verification`.
  - *Canaries.* Fixed prompts with mechanically checkable answers, sent to every real node hourly, every 25 jobs, and 5 minutes after a failure. Two consecutive failures mark the node `DEGRADED` (out of customer routing) until a canary passes. Mock nodes are never canaried.
  - Full re-execution of every request and attestation of the hardware remain PLANNED.
- **Benchmark on join.** The coordinator sends each new node a pinned, fixed-prompt job and times it. Decode tok/s on the coordinator's clock becomes the node's benchmark score and compute class (`EDGE` < 12 tok/s ≤ `CONSUMER` < 40 ≤ `PRO` < 90 ≤ `DATACENTER`, thresholds in `benchmark.ts`). Benchmark jobs issue no receipt and earn nothing. Mock nodes are timed but never classified.
- **Reliability (Brain Reliability Score).** 0–100, starts at 70, moves with completion rate, timeouts and uptime, minus up to 20 points for the redundant-execution mismatch rate and up to 30 for the canary failure rate (`reliabilityScore` in `registry.ts`). It is an input to routing, is shown on `/network` and `/provider`, and belongs to the node id, not to a wallet.

### Receipts — LIVE

`services/coordinator/receipts.ts`. `CanonicalReceiptBody` (`v, jobId, nodeId, model, inputTokens, outputTokens, executionMs, timestamp, requestHash, responseHash, hardwareClass, cost`) is serialised with sorted keys, hashed with sha256 and signed with the coordinator's ed25519 key (`BRAIN_COORDINATOR_SIGNING_SEED`, or derived from `BRAIN_SERVER_SECRET`). `GET /api/coordinator/signer` publishes the key; `verifyReceipt()` checks any receipt offline. Receipts are issued at high frequency off-chain; anchoring a batch hash on Solana is PLANNED and nothing on the site claims otherwise.

### Accounting — LIVE (ledger) / PLANNED (settlement)

`services/accounting.ts`. Each priced receipt accrues `COMPUTE_PROVIDER_EARNED` events per node using the published revenue split. `/provider` shows **accrued** (owed, at list price) and **settled** (paid, always 0 today) as two separate numbers with their basis. No settlement to wallets runs; the interface for Solana settlement is PLANNED.

### Store — LIVE

`services/store.ts`. `MemoryStore` for local development, `PgStore` with advisory locks for production. Node and job records are generic documents (`nnode`, `njob`) with indexed keys so hot paths (registry list, work queue) are single queries with short in-process caches.

**Database outage behaviour** (`services/failsoft.ts`). `PgStore` has a per-instance circuit breaker: two consecutive connection failures open it for 15 s, during which every query fails in microseconds with `StoreUnavailableError` (routes answer `503 database_unavailable` + `Retry-After`) instead of each waiting an 8 s connect timeout; one probe per window closes it. Public read routes (`/api/stats`, `/api/network/real`, `/api/coordinator/nodes`, `/jobs`) keep their last successfully built body and return it with `stale: true` and `asOf` while the database is unreachable; the UI shows "LIVE DATA DELAYED". No previous body means a fast 503, never an invented one. `sharedJson` adds `stale-if-error=3600` so the CDN keeps serving the last good body too. Browser nodes keep heartbeating through a 503 and are not dropped.

### Frontend — LIVE

Unchanged visual identity. New surfaces read only coordinator records:

- `/network` — request → router → node → response animation driven by the public SSE stream (prompts and outputs never appear on it), native node table with reported/measured labels, job pipeline. Shows **DEMO NETWORK** on the animation only when no node is online and no real job has moved.
- `/provider` — one node: state, reported GPU/load/VRAM, current model, jobs today, uptime, reliability, compute class, accrued vs settled earnings, sparklines from heartbeat history, speed per job.
- `/models` — the allowlist joined with live node counts, loaded counts, measured speed, lowest ask.
- `/developers` — "Change one URL. Run AI on Brain.", node models, response headers, node agent protocol.

## Request lifecycle (Brain Node path)

1. `POST /v1/chat/completions` with `model: "qwen/qwen2.5-7b-instruct"` (or `brain/*` when BRAIN AUTO picks the native network).
2. BRAIN AUTO estimates each class; the native provider answers from the registry (nodes serving the model, measured speed) or reports no capacity.
3. `createInferenceJob` → `matchJob`: `QUEUED → MATCHING → ASSIGNED`, routing reason stored on the job.
4. The node's long-poll returns the job; it posts `started`, streamed `progress` frames with sequence numbers, then `completed` with the response hash.
5. Coordinator verifies, transitions `VERIFYING → COMPLETED`, issues the signed receipt, accrues the ledger, updates the node's measured stats and reliability.
6. Gateway streams OpenAI-shaped chunks as progress arrives and closes with `event: brain` (route, cost, receipt id) and the `brain-*` headers.

## Local flow

`docker compose up` starts Postgres, the web app (gateway + coordinator + frontend) and a mock Brain Node; `npm run demo:request` sends a request and prints the answer, route, job timeline, receipt hash and signature. Without Docker: `npm run dev`, `npm run node:mock`, `npm run demo:request`.
