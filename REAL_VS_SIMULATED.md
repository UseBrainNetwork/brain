# Real vs simulated

This prototype mixes genuine system behavior with demo data. The UI badges every number:

- **LIVE**: measured or verified by this server.
- **SIM**: demo data.
- **EST**: an illustrative estimate.

This file is the source of truth for which is which. All demo values live in `services/mock/` and are served through `services/data.ts`. Components never hardcode them.

## Real

| Area | What actually happens | Where |
| --- | --- | --- |
| GPU detection | `navigator.gpu.requestAdapter()`, `adapter.info`, limits, and features, plus the WebGL unmasked renderer and `navigator.*`. Each field carries its source. Anything the browser doesn't expose is shown as *unavailable*, never guessed. VRAM is always unavailable, because browsers don't expose it. | `webgpu/detect.ts` |
| Benchmark | A real WGSL compute kernel (`mix_u32`) runs on your GPU against a server-issued, secret-seeded challenge. The server recomputes secret blocks and scores on its own clock. The score is not a TFLOPS figure, and the client's timing is ignored. | `webgpu/benchmark.ts`, `services/nodes.ts` |
| Network class | The device class comes from the adapter/renderer string, for display only. | `webgpu/detect.ts` |
| "Measure my GPU" in the earnings calculator | Runs the same detect → challenge → register path as /contribute. The score shown with LIVE is the server-verified one, and it replaces the preset in the estimate. The node is registered on standby until you join. Presets remain simulated medians. | `components/economics/EarningsCalculator.tsx`, `network/client/contributor.ts` |
| Node registration, join, heartbeat, offline sweep, leave | Real server state (in-memory, or Postgres if `DATABASE_URL` is set). | `services/nodes.ts`, `services/store.ts` |
| "The moment" | The join counter increments by exactly your node. The `NODE xxxx JOINED +score COMPUTE` event comes from the server's event bus over SSE. | `app/api/nodes/join`, `app/api/network/stream` |
| Jobs | Real `matmul_u32` / embedding-shaped matvec / canary kernels run on your GPU and are verified server-side (secret spot-check or full-answer canary, plausibility bound). Rejections are real. | `services/nodes.ts`, `services/verification.ts` |
| Jobs completed, verified compute, reputation, compute score on the dashboard | Server-computed values for your node. | `ContributeFlow.tsx` (LIVE badges) |
| Real nodes table, LIVE jobs in the explorer, `/explorer/job/<id ≥ 5000000>` | Server state. | `app/api/network/state`, `app/api/jobs/[id]` |
| Wallet connect | Phantom/Solflare/Backpack sign a server nonce, verified server-side with ed25519. | `lib/wallet`, `services/wallet.ts` |
| Token holdings | Real SPL balance via RPC **only if** `SOLANA_RPC_URL` and `BRAIN_TOKEN_MINT` are set. | `services/wallet.ts` |
| Reward formula | The actual allocation function, tested. | `rewards/formula.ts` |
| Inference gateway and router | Real validation, routing, fallback, and upstream call when a provider is configured. Without one, it returns an honest `503` with the routing trace. | `api/gateway.ts`, `providers/` |
| Playground latency and execution target | Measured on the real request. | `components/inference/Playground.tsx` |
| Security | Rate limits, hashed session tokens, hashed IPs, no client-side secrets. | `services/security.ts` |
| Epoch settlement | Per-wallet verified compute, availability (5-minute buckets with an assigned job) and pass rate are measured from server job records, then run through the reward formula. Each epoch is written once. | `services/settlement.ts` |
| Claims and payouts | A wallet signs an HMAC-bound claim (address, lamports, single-use nonce, expiry). The server re-checks the balance with the claim counted, enforces one pending claim per wallet, per-claim and 24h caps, then sends a SOL transfer from the payout wallet. Verified on a local Solana validator. **Off unless `BRAIN_PAYOUTS_ENABLED=true` and a payout key are set.** | `services/claims.ts`, `services/payouts.ts` |
| Multi-device demo (`/node`, `/demo`) | Each browser is a separate node with a persistent anonymous id. RUN TEST JOB creates a real distributed job: a parallel `u32` matrix multiplication split into work units, assigned to the real nodes online, executed with WebGPU, spot-checked by the server, reassigned if a node disappears (heartbeat timeout or orphaned unit), and failed with a reason if it cannot finish. Every figure on the JOB COMPLETE panel comes from the job record. It is not LLM inference and is labeled as such. | `services/distributed.ts`, `components/demo/`, `components/node/` |
| Compute receipts (`/receipt/[id]`) | Issued by the server when a distributed job or a routed chat request settles. Nodes, verified/failed/reassigned units, compute units, latency, verification method and confidence are copied from server records. `resultHash` is a sha256 over the ordered verified unit outputs: an integrity digest anyone can recompute from the same outputs, **not** a cryptographic proof of execution. `attestation` is `{ kind: "none" }`; signatures and anchoring are future work and are not faked. | `services/receipts.ts` |
| Receipt money fields | `customerCost`, `providerCompensation`, `protocolRevenue` are `null` (rendered UNKNOWN) unless an operator list price is configured. Priced receipts are marked `basis: "list-price"`: owed at list price, nothing collected. | `lib/pricing.ts` |
| Accounting and `/economics` | Every cell is a sum over `AccountingEvent`s with `source: "REAL"`. `accrued` = owed at list price; `settled` = backed by a transaction reference (none exist yet). Empty cells say NOT ENOUGH DATA. `SIMULATED` events are stored under a different key and cannot enter the REAL snapshot (tested). | `services/accounting.ts` |
| Node reputation (`/node/[nodeId]`) | Jobs completed/failed/verified, verification rate, reassignment rate, median latency (assign → verified, server clock), uptime (heartbeats observed ÷ expected) and the reputation score are computed from the server's job and heartbeat records. Nothing is client-reported. | `services/nodeProfile.ts` |
| BRAIN AUTO (`/auto`, `POST /api/orders`, `/v1/chat/completions` with `priority`) | Every execution target returns an estimate: browser network from live nodes and the median of same-size completed jobs; upstream providers from configured prices and measured latency samples. Unknown cost or latency stays UNKNOWN and is penalised in scoring, never guessed. The decision (scores, weights, rejections) is stored and shown on the receipt. | `engine/providers.ts`, `engine/router.ts`, `engine/orders.ts` |
| Capacity (`/capacity`) | States derive from live node count, recent job outcomes and configured providers. Matmul sizes need enough online nodes; redundant verification needs ≥ 2; embeddings and LLM inference are EXPERIMENTAL (upstream passthrough only) and never claimed as browser-network capabilities. | `services/capability.ts` |
| Creator-reward treasury | Balance, received, allocated are sums over recorded receipts. The `mock` adapter is SIMULATED and only feeds SIMULATED records; the `manual` adapter records what an operator posts with a transaction reference; the `pumpfun` adapter is **not implemented** and reports so. Nothing is scraped. | `services/treasury.ts` |
| Reward epochs v2 (`/epoch/[id]`) | Nodes are measured from job records over the epoch window, run through the reward engine, and the result is written once with a hash of its allocations. Re-finalizing returns the stored epoch. Zero verified compute always allocates zero (tested). | `services/epochs.ts`, `rewards/engine.ts` |
| Customer API keys, usage, request history | Keys are random, shown once, stored as sha256. Usage sums the server's request records. | `services/customers.ts` |
| Operations (`/network`) | Everything is read from the server's records and the in-process event bus. | `app/api/network/ops` |

## Simulated

| Area | Notes | Where |
| --- | --- | --- |
| Network size (12,842 GPUs), memory (68.4 TB), inferences, req/s, uptime, capacity index | Demo baseline with small random drift. Real nodes are added on top. | `services/mock/mockData.ts` |
| Device-class cluster sizes and median scores | Demo. Medians are loosely calibrated against one real M4 Max measurement. | `mockData.ts → deviceClasses` |
| Background job stream, event feed (non-green rows), topology particles | Deterministic generator. Job ids < 5,000,000 are simulated, and any of them renders a consistent detail page. | `services/mock/mockNetwork.ts`, `network/realtime/sources.ts` |
| Compute die (home hero, /brain, /contribute) | 1 cell = 1 node from the simulated count. Cell activity is ambient, sampled at the simulated req/s. Real nodes on this server rise as labelled pillars (orange = you, green = others) driven by real join/verify events. | `components/network/ComputeDie.tsx` |
| Explorer job chain, inference router switchboard | Built from the same job stream. In the switchboard, bright comets are individual stream events; faint lines are background traffic sampled from pool req/s. | `components/explorer/JobChain.tsx`, `components/inference/Switchboard.tsx` |
| Money-flow Sankey on /rewards | Ribbon widths are today's simulated dollars; the split percentages are the real config. `/economics` itself is REAL only. | `components/economics/MoneyFlow.tsx`, `rewards/config.ts` |
| Demo controls on `/demo` (SMALL / MEDIUM / LARGE, units per node, redundancy) | Change the real job that is created. They never change timing or results; processing time is whatever the GPUs take. | `components/demo/DemoScreen.tsx` |
| Model pools (Qwen 32B, DeepSeek Distill, Embeddings, Vision) | Demo. No LLM runs on the browser network in V1. | `mockData.ts → modelPools` |
| Creator rewards, compute payouts, inference revenue (today/7d/30d/all) | Demo. **Not connected to any wallet or billing.** | `mockData.ts → revenue` |
| Token price (`BRAIN $0.001842`) | Demo, not market data. | `mockData.ts → token` |
| Top contributors | Demo rows with anonymous ids. | `mockData.ts → topContributors` |
| Shard plan in the playground (REQUEST → SPLIT → NODE … → MERGE → RESPONSE) | Shows how the request *would* be partitioned. The answer itself comes from the configured provider. | `api/gateway.ts → shardPlan` |
| Holdings without RPC config, and the "demo wallet" | Deterministic simulated balance. | `services/wallet.ts`, `lib/wallet/adapters.ts` |
| Epoch history on /rewards for a wallet with nothing settled | Deterministic demo history, shown with a banner, only while payouts are off. Never claimable. | `services/mock/mockRewards.ts` |
| Epochs settled without an operator pool or on-chain holdings | Settle with the simulated pool (demo USD pool ÷ demo SOL price) and provenance SIM. Never claimable. | `services/settlement.ts`, `mockData.ts → demoSolPriceUsd` |

## Estimated (real formula, simulated inputs)

| Area | Notes |
| --- | --- |
| Reward multiplier, estimated daily reward, per-job `+$0.0000xx`, session/today/all-time earnings | `rewards/simulate.ts` runs the real formula against the simulated network and pool. The per-job rate uses `networkAggregates.unitsPerScorePerDay` (matched to the V1 dispatcher pace). Nothing is paid out. Earnings are stored in `localStorage` only. |
| "This epoch" accrued on /rewards | Real verified work so far, against the last live pool (or the simulated pool) pro-rated to elapsed time. Becomes a real allocation only when the epoch settles. |
| Inference prices | Shown as `$X.XX` until cost benchmarks exist. No savings claims are made. |
| Avg cost / 1M tokens on the home page | `$0.XX` placeholder, for the same reason. |

## Never mixed

- A `ComputeReceipt`, `AccountingEvent`, `ComputeOrder`, `CreatorRewardTreasury` and `RewardEpochV2` each carry `source: "REAL" | "SIMULATED"`. Stores index on it, snapshots filter on it, and the test suite asserts that SIMULATED data cannot enter REAL totals, that clients cannot self-report earnings or verified compute, and that zero verified compute yields zero reward.

## Never claimed

- No TFLOPS or VRAM figures.
- No fabricated benchmark results. Every score shown for *your* device was measured in your tab and verified by the server.
- No "X% cheaper" comparisons.
- No token emissions, no staking yield, no price expectations.
- No LLM inference on the browser network. The distributed job is an integer matrix multiplication and says so.
- No cryptographic proof of execution. The receipt hash is an integrity digest; attestation is marked `none` until it exists.
- No revenue, customers or savings that are not in the accounting records. Unpriced work is UNKNOWN, not estimated.
