<p align="center">
  <a href="https://brainnetwork.app"><img src=".github/assets/hero.svg" alt="brain — the crowd is the GPU" width="100%"></a>
</p>

<p align="center">
  <a href="https://brainnetwork.app/network"><img alt="nodes online" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fbrainnetwork.app%2Fapi%2Fstats&query=%24.nodesOnline&label=nodes%20online&color=3d5afe&labelColor=0b0d11&style=flat-square"></a>
  <a href="https://brainnetwork.app/explorer"><img alt="jobs completed" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fbrainnetwork.app%2Fapi%2Fstats&query=%24.jobsCompleted&label=jobs%20completed&color=27c46d&labelColor=0b0d11&style=flat-square"></a>
  <a href="https://brainnetwork.app/explorer"><img alt="work units verified" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fbrainnetwork.app%2Fapi%2Fstats&query=%24.workUnitsVerified&label=work%20units%20verified&color=27c46d&labelColor=0b0d11&style=flat-square"></a>
  <a href="https://brainnetwork.app/api/stats"><img alt="store" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fbrainnetwork.app%2Fapi%2Fstats&query=%24.backend&label=store&color=e6e9ee&labelColor=0b0d11&style=flat-square"></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-89%20passing-27c46d?labelColor=0b0d11&style=flat-square">
  <img alt="stack" src="https://img.shields.io/badge/Next.js%2016%20%C2%B7%20React%2019%20%C2%B7%20WebGPU%20%C2%B7%20Postgres-0b0d11?labelColor=0b0d11&color=1a1e26&style=flat-square">
</p>

<p align="center">
  <a href="https://brainnetwork.app"><b>brainnetwork.app</b></a> ·
  <a href="https://brainnetwork.app/node">Contribute a GPU</a> ·
  <a href="https://brainnetwork.app/developers">Developers</a> ·
  <a href="https://brainnetwork.app/network">Network ops</a> ·
  <a href="https://brainnetwork.app/economics">Economics</a> ·
  <a href="REAL_VS_SIMULATED.md">Real vs simulated</a>
</p>

<img src=".github/assets/divider.svg" width="100%" alt="">

**brain** is a distributed AI compute network that runs in the browser. Contributors open a tab; the server measures and verifies their WebGPU compute; they earn a share of real revenue. Developers buy inference through an OpenAI-compatible API. There are no token emissions and no passive staking. Holding the token raises a contributor's reward weighting, but **only verified compute earns**, and zero verified compute always produces zero reward.

> **Status.** Phase 2 prototype, live at [brainnetwork.app](https://brainnetwork.app). The full path is real end to end on one server: device detection → server-verified benchmark → join → verified distributed jobs → proof-of-compute receipts → node reputation → routing (`brain/auto`) → accounting → reward epochs. Network-wide marketing numbers, the token price and the distributed-LLM path are **simulated and labeled as such** in the UI. The badges above come from [`/api/stats`](https://brainnetwork.app/api/stats), which reports only values this server has measured.

<img src=".github/assets/divider.svg" width="100%" alt="">

## One request, traced

<p align="center"><img src=".github/assets/trace.svg" alt="A request passing through the gateway, router, four verified nodes, merge and response" width="100%"></p>

1. **Request.** `POST /v1/chat/completions` with `model: brain/auto`. Same shape as the OpenAI API, so existing SDKs work unchanged.
2. **Gateway.** API key, rate limit, schema validation, and a usage meter every later step reports into.
3. **Router.** Every execution target (browser network, cloud fallback, external provider) is estimated on compatibility, live capacity, latency, cost and reliability. The cheapest valid one wins; the decision is recorded.
4. **Split.** Work is cut into units sized by each node's *server-measured* score and the memory its adapter could actually allocate. Nothing the browser claims is trusted.
5. **Nodes.** WGSL compute kernels run through WebGPU on ordinary machines.
6. **Verify.** Rows chosen in secret before dispatch are recomputed server-side. Canary jobs have known answers. Low-reputation nodes get redundant replicas. Kernels are integer (u32 wrapping), so verification is bit-exact, not tolerance-based.
7. **Merge.** Verified units are reassembled in order. A failed unit is re-dispatched and the node loses reputation.
8. **Response + receipt.** `200 OK`, a shareable [proof-of-compute receipt](https://brainnetwork.app/receipt/r-5000002), and verified compute units credited to each node for the open reward epoch.

<img src=".github/assets/divider.svg" width="100%" alt="">

## What is real today

Every number in the product carries a provenance badge: **LIVE** (measured or verified by this server), **SIM** (demo data from `services/mock/`) or **EST** (the real formula on simulated inputs). Real and simulated values are never mixed in one figure.

| Real, end to end | Simulated, labeled |
| --- | --- |
| WebGPU detection, server-timed benchmark, join, heartbeat | Network-wide node counts, GPU totals, req/s on the marketing pages |
| Distributed `matmul_u32` jobs across real browsers, secret spot-check verification | Token price and market data |
| Proof-of-compute receipts with result hashes and route decisions | Distributed LLM inference across the browser pool |
| Node reputation (EWMA, failures weigh double, bans below 0.35) | Illustrative earnings in the calculator |
| `brain/auto` routing across browser network / cloud / external provider | — |
| Chat completions through a configured OpenAI-compatible upstream | — |
| Accounting events, reward epochs, Postgres persistence with advisory-locked job updates | — |

Full table with the rules we hold ourselves to: [REAL_VS_SIMULATED.md](REAL_VS_SIMULATED.md).

<img src=".github/assets/divider.svg" width="100%" alt="">

## Try it

**Contribute.** Open [brainnetwork.app/node](https://brainnetwork.app/node) in Chrome, Edge, Safari 26+ or Firefox 141+ (Windows) and press *Join network*. Your device is benchmarked by the server, joins the pool, and receives verified work. Open [/demo](https://brainnetwork.app/demo) on another device to watch the room and run a test job across everything connected.

**Build.** The API is OpenAI-compatible:

```bash
curl https://brainnetwork.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{ "model": "brain/auto", "messages": [{ "role": "user", "content": "explain entropy in one line" }] }'
```

Every response carries a `brain` extension with the target, provider, latency, the full routing decision, and a receipt id. If no target is eligible the API returns `503 no_provider_available` with the routing trace, never an invented answer.

```json
"brain": {
  "target": "EXTERNAL_PROVIDER",
  "provider": "external",
  "latencyMs": 284,
  "cost": { "amount": 0.0000084, "currency": "USD", "basis": "list-price" },
  "receiptId": "r-c-muudky9h-lvge",
  "verification": "unverified-provider-response"
}
```

<img src=".github/assets/divider.svg" width="100%" alt="">

## Security model

Contributors are assumed adversarial. The server does **not** trust any client-reported GPU model, compute units, job completion, benchmark score or uptime.

- **GPU model** is display-only. Placement and rewards use the server-measured score.
- **Benchmark score** is the server's clock between issuing a seeded challenge and receiving a verified answer.
- **Job completion** counts only after a canary or secret spot-check passes, within plausibility bounds. Expected outputs and sampled indices never leave the server.
- **Uptime** is derived from server-received heartbeats.
- **Reputation** is an EWMA where failures weigh double; nodes below 0.35 are banned.
- **Rate limits** are per hashed IP. Session tokens are random and stored only as SHA-256 hashes.
- **Provider keys** live only in server env; upstream errors are mapped to fixed strings. The client bundle contains no secret names or values.
- **Wallets** prove ownership by signing a server nonce (ed25519). Public pages show anonymous 4-hex node ids, never wallets, IPs or device names.

Report a vulnerability: [SECURITY.md](SECURITY.md).

<img src=".github/assets/divider.svg" width="100%" alt="">

## Rewards

`rewards/formula.ts`, every parameter in `rewards/config.ts`:

```
normCompute = verifiedCompute / meanVerifiedCompute
normToken   = min(tokens / supply, cap) / meanTokenShare
effToken    = max(normToken, λ · normCompute)        # non-holders still earn on compute
mult        = min(√(normCompute · effToken) / (√λ · normCompute), maxMultiplier)
score       = √λ · normCompute · mult · quality       # quality = reliability · completion · availability^0.5
share       = water-filled under maxNodeShareOfPool
```

Properties covered by tests: tokens alone earn exactly 0; banned and sub-threshold nodes earn 0; splitting wallets or compute gains nothing; the multiplier is capped (max 1.35×); no node exceeds the pool cap; allocations never exceed the pool. Pricing, splits and the current list prices are documented in [ECONOMICS.md](ECONOMICS.md). We do not publish projected returns.

<img src=".github/assets/divider.svg" width="100%" alt="">

## Run it locally

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # vitest: workloads, verification, routers, reward engine, receipts/accounting invariants
npm run typecheck
npm run build && npm start
```

Node 20+. Without any configuration the app runs on an in-memory store with simulated holdings and returns an honest `503` from the inference API. Copy `.env.example` to `.env.local` to configure; **every variable is server-only** except `NEXT_PUBLIC_BRAIN_WS_URL`.

<details>
<summary><b>Environment variables</b></summary>

| Variable | Effect |
| --- | --- |
| `BRAIN_EXTERNAL_BASE_URL` / `_API_KEY` / `_MODEL` | OpenAI-compatible external provider for `/v1/chat/completions` (production uses OpenRouter) |
| `BRAIN_FALLBACK_BASE_URL` / `_API_KEY` / `_MODEL` | Self-hosted cloud fallback (e.g. vLLM) |
| `BRAIN_API_KEYS` | Comma-separated keys required on `/v1/*`. Empty = open but rate limited |
| `DATABASE_URL` (or `POSTGRES_URL` as injected by Vercel's Supabase/Neon/Prisma integrations) | Postgres instead of the in-memory store. `db/schema.sql` is applied automatically on first connection (idempotent); distributed-job updates are serialized with transaction-scoped advisory locks so several instances can share one database |
| `SOLANA_RPC_URL` + `BRAIN_TOKEN_MINT` | Real SPL token holdings lookup |
| `NEXT_PUBLIC_BRAIN_WS_URL` | External WebSocket event bus (defaults to the built-in SSE stream) |
| `BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS` | List price for browser-network compute. Unset = receipts carry `UNKNOWN` cost and no accounting events are created |
| `BRAIN_PRICE_USD_PER_1M_TOKENS` / `BRAIN_FALLBACK_PRICE_USD_PER_1M` / `BRAIN_EXTERNAL_PRICE_USD_PER_1M` | List price for chat tokens and the upstream cost of each provider. Unset = `UNKNOWN`, never estimated |
| `BRAIN_EXTERNAL_EMBED_MODEL` | Enables `/v1/embeddings` passthrough to the external provider |
| `BRAIN_ADMIN_TOKEN` | Bearer token for operator routes: create customers/API keys, finalize epochs, record manual treasury receipts |
| `BRAIN_DEMO_TOKEN` | Optional. When set, `POST /api/jobs` and `POST /api/orders` from the console require it |
| `BRAIN_SERVER_SECRET` | HMAC key for session tokens and claims. Set it in production |
| `BRAIN_PAYOUTS_ENABLED` + `BRAIN_PAYOUT_SECRET_KEY` | Enable SOL claim payouts. Off by default |

To exercise the inference success path without a real provider:

```bash
node scripts/mock-upstream.mjs 3999
BRAIN_EXTERNAL_BASE_URL=http://localhost:3999/v1 BRAIN_EXTERNAL_API_KEY=test BRAIN_EXTERNAL_MODEL=mock npm run dev
```

</details>

<details>
<summary><b>Pages</b></summary>

| Route | What it is |
| --- | --- |
| `/` | Hero, live network topology + event feed, "One request, traced", economics flywheel |
| `/contribute` | Detect → benchmark → wallet (optional) → join → live contributor dashboard |
| `/node` | Full-screen worker: JOIN NETWORK → WAITING → JOB RECEIVED → COMPUTING → VERIFYING → VERIFIED +N units |
| `/demo` | Live room view: real node count, join topology, RUN TEST JOB (real parallel `matmul_u32`), per-unit lifecycle |
| `/auto` | `brain/auto` console: one request, every target estimated, cheapest valid one executed, receipt issued |
| `/inference` | Models, pricing, playground through the real gateway |
| `/explorer` | Live jobs, real nodes, top contributors; `/explorer/job/[id]` lifecycle |
| `/receipt/[id]` | Shareable proof-of-compute receipt: nodes, verification, result hash, cost, route decision |
| `/node/[nodeId]` | Node reputation measured by the server from issued work |
| `/network` | Operations view: is this real, is compute happening, is someone paying, who is doing the work, where is the money going |
| `/economics` | REAL live economics: customers paid, providers earned, creator rewards, protocol revenue, cost, margin; epochs; accounting events |
| `/rewards` | Reward formula explainer, calculator, epoch history, claims |
| `/epoch/[id]` | Immutable reward epoch with its allocations and hash |
| `/capacity` | What the network can run right now (AVAILABLE / LIMITED / UNAVAILABLE / EXPERIMENTAL) |
| `/developers` | Quickstart (Python/JS/cURL), request path, routing, response format, node protocol, verification |
| `/brain` | The network as one machine: totals, dense topology, model pools, job waterfall |

</details>

<details>
<summary><b>Repository layout</b></summary>

```
app/          Next.js routes (pages + /api route handlers)
components/   UI, grouped by page; components/ui.tsx holds primitives
domain/       Shared types: ComputeNode, ComputeJob, ModelPool, RewardEpoch, NodeBenchmark, …
webgpu/       Browser-side: device detection, WGSL kernels, ComputeBackend, benchmark
network/      workloads.ts (deterministic workloads shared by GPU, CPU and server),
              client/contributor.ts (contributor engine), realtime/ (event sources + store)
services/     Server-side: nodes & jobs, verification, reputation, security, wallet,
              store (memory | Postgres), event bus, mock/ (ALL demo data lives here)
rewards/      Reward formula, configurable reward engine, config, simulator, tests
engine/       brain/auto: ExecutionProvider implementations, scoring router, compute orders
providers/    Inference providers (browser network, OpenAI-compatible) + gateway router
api/          Gateway (validation → routing → fallback → OpenAI-shaped response)
lib/          Config (non-secret), formatting, pricing, wallet adapters
db/           Postgres schema (self-applied on first connection)
scripts/      Dev utilities: e2e flows in headless Chrome with real WebGPU, screenshots, mock upstream
```

</details>

<details>
<summary><b>Contributor protocol</b></summary>

```
browser                                         server
───────                                         ──────
detectDevice()  adapter.info, limits, WebGL renderer, navigator.*
                every field tagged with its source; unknowns = "unavailable"
probeThroughput() ── hint ──────────────────▶  POST /api/benchmark/challenge
                                                 issues mix_u32 spec, secret seed,
                                                 rounds sized to ~400 ms. Clock starts.
run WGSL kernel  ── block hashes ───────────▶  POST /api/nodes/register
                                                 recompute 3 secret blocks on CPU
                                                 score = ops / server-measured seconds / 1e7
JOIN NETWORK     ───────────────────────────▶  POST /api/nodes/join → node.joined event
loop:            ───────────────────────────▶  POST /api/jobs/next   (seeded spec only)
  run kernel     ── row/block hashes ───────▶  POST /api/jobs/result
                                                 canary (full answer) or secret spot-check,
                                                 plausibility bound, reputation EWMA,
                                                 compute credited, job.completed event
heartbeat 5 s    ───────────────────────────▶  POST /api/nodes/heartbeat (offline after 20 s)
```

</details>

<img src=".github/assets/divider.svg" width="100%" alt="">

## Verification we have done

- `typecheck`, `build` and `test` (89 tests) pass.
- Multi-device demo in headless Chrome with real WebGPU (`scripts/multitab.mjs`): four browser contexts join through `/node`, `/demo` counts 1→4 real nodes, a job verifies 16/16 units across all four. With `--kill`, a node closed mid-job has its unit reassigned and the job still completes.
- Phase 2 path (`scripts/phase2.mjs`): three nodes join, a compute order is placed through `/auto`, the browser network is selected, the job runs, a receipt is issued and renders, and `/node/<id>`, `/network`, `/economics`, `/capacity` render from the same records.
- Production on Postgres (Supabase via Vercel): two real devices, 8/8 units verified, receipt persisted across deploys.
- All routes return 200, no hydration errors, no horizontal overflow at 1440 px or 390 px (`scripts/routes.mjs`).
- WebGPU fallback tested with a missing `navigator.gpu` and a null adapter: the benchmark is withheld and unknown fields are labeled.

## Documents

| | |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Modules, data flow, store and locking, event bus |
| [ECONOMICS.md](ECONOMICS.md) | Pricing config, how list prices were derived, splits, what is never claimed |
| [REAL_VS_SIMULATED.md](REAL_VS_SIMULATED.md) | Every number's provenance and the rules for mixing (never) |
| [PHASE_3.md](PHASE_3.md) | Deploy runbook, 5-device demo script, known limitations, critical path |
| [NEXT_STEPS.md](NEXT_STEPS.md) | Open work |

## What we will not build

Token emissions. Passive staking. Points, quests, node licenses, NFTs. Promised returns or implied price appreciation. Fabricated benchmarks or "cheaper than X" claims. Our own foundation model.

## Design

Cool graphite surfaces, one signal color (cobalt `#3d5afe`) reserved for work in flight, green only for verified work. Geist paired with JetBrains Mono. Animations show real system behavior: particles are jobs, flashes are joins and leaves, the cobalt marker is your node. The README assets are generated by `scripts/github-assets.mjs`.

## License

To be decided before public launch. Until a license file is added, all rights are reserved.
