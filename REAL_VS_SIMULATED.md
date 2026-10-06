# Real vs simulated

This prototype mixes genuine system behavior with demo data. The UI badges every number:

- **LIVE**: measured or verified by this server.
- **SIM**: demo data.
- **EST**: an illustrative estimate.

**Default is real only.** Out of the box the site shows nothing simulated: counts, feeds, metrics and rankings come only from this server, and sections whose figures exist only in the model (reward estimates, money flow) say so instead of showing a number. The footer button **Show simulated data** switches to demo mode, where a simulated network is blended in and every such figure is labelled SIM. The choice is stored in the browser (`brain.mode.v1`); `?mode=demo` or `?mode=real` in the URL overrides it. `/demo` and `/node` are always real.

This file is the source of truth for which is which. All demo values live in `services/mock/` and are served through `services/data.ts`. Components never hardcode them. Mode gating lives in `network/realtime/mode.ts` (`useSim`) and `components/layout/SimOnly.tsx`.

## Real

| Area | What actually happens | Where |
| --- | --- | --- |
| GPU detection | `navigator.gpu.requestAdapter()`, `adapter.info`, limits, and features, plus the WebGL unmasked renderer and `navigator.*`. Each field carries its source. Anything the browser doesn't expose is shown as *unavailable*, never guessed. VRAM is always unavailable, because browsers don't expose it. | `webgpu/detect.ts` |
| Benchmark | A real WGSL compute kernel (`mix_u32`) runs on your GPU against a server-issued, secret-seeded challenge. The server recomputes secret blocks and scores on its own clock. The score is not a TFLOPS figure, and the client's timing is ignored. | `webgpu/benchmark.ts`, `services/nodes.ts` |
| Network class | The device class comes from the adapter/renderer string, for display only. | `webgpu/detect.ts` |
| "Measure my GPU" in the earnings calculator | Runs the same detect → challenge → register path as /earn. The score shown with LIVE is the server-verified one, and it replaces the preset in the estimate. The node is registered on standby until you join. Presets remain simulated medians. | `components/economics/EarningsCalculator.tsx`, `network/client/contributor.ts` |
| Node registration, join, heartbeat, offline sweep, leave | Real server state (in-memory, or Postgres if `DATABASE_URL` is set). | `services/nodes.ts`, `services/store.ts` |
| "The moment" | The join counter increments by exactly your node. The `NODE xxxx JOINED +score COMPUTE` event comes from the server's event bus over SSE. | `app/api/nodes/join`, `app/api/network/stream` |
| Jobs | Real `matmul_u32` / embedding-shaped matvec / canary kernels run on your GPU and are verified server-side (secret spot-check or full-answer canary, plausibility bound). Rejections are real. | `services/nodes.ts`, `services/verification.ts` |
| Jobs completed, verified compute, reputation, compute score on the dashboard | Server-computed values for your node. | `ContributeFlow.tsx` (LIVE badges) |
| Real nodes table, LIVE jobs in the explorer, `/explorer/job/<id ≥ 5000000>` | Server state. | `app/api/network/state`, `app/api/jobs/[id]` |
| Wallet connect | Phantom/Solflare/Backpack sign a server nonce, verified server-side with ed25519. | `lib/wallet`, `services/wallet.ts` |
| Token holdings | Real SPL balance via RPC **only if** `SOLANA_RPC_URL` and `BRAIN_TOKEN_MINT` are set. | `services/wallet.ts` |
| Reward formula | The actual allocation function, tested. | `rewards/formula.ts` |
| Inference gateway and router | Real validation, BRAIN AUTO routing, fallback before first byte, and upstream call when a provider is configured. Streaming and non-streaming both produce a receipt. Without a provider, an honest `503` with the routing trace. | `api/gateway.ts`, `api/chatStream.ts`, `engine/` |
| `/chat` and "HOW BRAIN RAN THIS" | Every field (route, model, nodes, cost, latency, verified, receipt id) is copied from the order, decision and receipt the server wrote for that request. `VERIFIED: NO` is shown for upstream model responses. Conversations are stored only in the browser's `localStorage`. | `components/chat/ChatApp.tsx`, `api/chatStream.ts` |
| Accounts, plans, credits (`/account`, `/pricing`) | Accounts are signed-cookie identities created on first use. Credits are a ledger over real receipts: granted once per month from plan config, consumed as `customerCost ÷ creditUsd`, offset by REAL `COMPUTE_PROVIDER_EARNED` events for nodes the attached wallet powers. UNKNOWN cost consumes 0 and is flagged. `PURCHASE` events are reserved and never written because payments are not connected; Pro and Max are labelled PLACEHOLDER. | `services/accounts.ts`, `services/credits.ts`, `services/accountSummary.ts`, `lib/plans.ts` |
| Homepage metrics strip and resource classes | Read from `/api/stats` and `/api/capacity`; show NO DATA / UNAVAILABLE rather than a number when nothing has been measured or configured. | `components/home/RealMetrics.tsx` |
| Upstream provider cost | When the external provider reports the charge for a request, it is recorded as `INFRASTRUCTURE_COST` with basis `provider-reported`. The customer's price is the configured list price. The two are never blended. | `engine/providers.ts`, `services/accounting.ts` |
| Security | Rate limits, hashed session tokens, hashed IPs, no client-side secrets. | `services/security.ts` |
| Epoch settlement | Per-wallet verified compute, availability (5-minute buckets with an assigned job) and pass rate are measured from server job records, then run through the reward formula. Each epoch is written once. | `services/settlement.ts` |
| Claims and payouts | A wallet signs an HMAC-bound claim (address, lamports, single-use nonce, expiry). The server re-checks the balance with the claim counted, enforces one pending claim per wallet, per-claim and 24h caps, then sends a SOL transfer from the payout wallet. Verified on a local Solana validator. **Off unless `BRAIN_PAYOUTS_ENABLED=true` and a payout key are set.** | `services/claims.ts`, `services/payouts.ts` |
| Multi-device demo (`/node`, `/demo`) | Each browser is a separate node with a persistent anonymous id. RUN TEST JOB creates a real distributed job: a parallel `u32` matrix multiplication split into work units, assigned to the real nodes online, executed with WebGPU, spot-checked by the server, reassigned if a node disappears (heartbeat timeout or orphaned unit), and failed with a reason if it cannot finish. Every figure on the JOB COMPLETE panel comes from the job record. It is not LLM inference and is labeled as such. | `services/distributed.ts`, `components/demo/`, `components/node/` |
| Network inference (`/chat` NETWORK mode, `/node` model stage) | Real. Qwen3 (Apache-2.0) in GGUF: 1.7B Q4_0 by default (4 stages), 4B Q4_0 once enough nodes are on (6 stages), 0.6B Q8_0 as the small tier (3 stages). A node downloads only its stage's tensors (range requests to the Hugging Face CDN, cached) and runs them with Q4_0/Q8_0 WebGPU kernels that match the CPU reference to ≤ 6e-4 relative RMS (`/dev/llm-check`); it keeps a per-session f16 KV cache. The first stage holds the embedding, the last the final norm and tied output head and returns top-64 logits; the gateway holds no weights, it tokenizes and samples. Hidden states move node → node as f16 over a persistent WebSocket relay (Cloudflare Durable Object, `relay/`, HMAC tickets from the gateway) and every lap carries the next token plus up to 4 prompt-lookup drafts verified in one pass with KV rollback, so output is identical to plain decoding. Every stage of every lap runs on two nodes when two hold it; outputs must agree within 2e-3 relative RMS (top-k: ≥ 48 shared ids). Only fully checked, agreeing nodes get verified units (`kind: inference`, spec `llm_stage`); unchecked work is recorded as `no-replica` and earns nothing. Receipts show the model, nodes per stage, hops, drafted tokens, first-token time and tokens/s as measured. No charge. | `inference/`, `webgpu/llm.ts`, `relay/`, `services/relay.ts`, `services/inference.ts`, `api/networkChatStream.ts`, `network/client/inferenceWorker.ts` |
| Compute receipts (`/receipt/[id]`) | Issued by the server when a distributed job or a routed chat request settles. Nodes, verified/failed/reassigned units, compute units, latency, verification method and confidence are copied from server records. `resultHash` is a sha256 over the ordered verified unit outputs: an integrity digest anyone can recompute from the same outputs, **not** a cryptographic proof of execution. `attestation` is `{ kind: "none" }`; signatures and anchoring are future work and are not faked. | `services/receipts.ts` |
| Receipt money fields | `customerCost`, `providerCompensation`, `protocolRevenue` are `null` (rendered UNKNOWN) unless an operator list price is configured. Priced receipts are marked `basis: "list-price"`: owed at list price, nothing collected. | `lib/pricing.ts` |
| Accounting and `/economics` | Every cell is a sum over `AccountingEvent`s with `source: "REAL"`. `accrued` = owed at list price; `settled` = backed by a transaction reference (none exist yet). Empty cells say NOT ENOUGH DATA. `SIMULATED` events are stored under a different key and cannot enter the REAL snapshot (tested). | `services/accounting.ts` |
| Node reputation (`/node/[nodeId]`) | Jobs completed/failed/verified, verification rate, reassignment rate, median latency (assign → verified, server clock), uptime (heartbeats observed ÷ expected) and the reputation score are computed from the server's job and heartbeat records. Nothing is client-reported. | `services/nodeProfile.ts` |
| BRAIN AUTO (`/auto`, `/chat`, `POST /api/orders`, `/v1/chat/completions` with `mode` / `privacy`) | Every resource class returns an estimate: browser network from live nodes and the median of same-size completed jobs; upstream providers from configured prices and measured latency samples; `NATIVE_NETWORK` always reports unsupported because it is not built. Unknown cost, latency or quality tier stays UNKNOWN and is penalised in scoring, never guessed. Privacy is a hard constraint. The decision (scores, weights, rejections, attempts) is stored and shown on the receipt. See `ROUTING.md`. | `engine/providers.ts`, `engine/router.ts`, `engine/plan.ts`, `engine/orders.ts` |
| Capacity (`/capacity`) | States derive from live node count, recent job outcomes and configured providers. Matmul sizes need enough online nodes; redundant verification needs ≥ 2; `chat-external` / `chat-cloud` / `embeddings-external` are UNAVAILABLE when unconfigured, LIMITED when configured but unmeasured or under 90 % reliability, and never claimed as browser-network capabilities. | `services/capability.ts` |
| Creator-reward treasury | Balance, received, allocated are sums over recorded receipts. The `pumpfun` adapter reads the chain: a receipt is a transaction where SOL left one of our pump.fun creator-fee vault PDAs and landed in the protocol wallet, keyed by signature. Unclaimed fees in the vault are shown as such and never counted. The `manual` adapter records what an operator posts with a transaction reference; the `mock` adapter is SIMULATED and only feeds SIMULATED records. Nothing is estimated. | `services/treasury.ts`, `services/solana.ts` |
| Reward epochs v2 (`/epoch/[id]`) | Nodes are measured from job records over the epoch window, run through the reward engine, and the result is written once with a hash of its allocations. Re-finalizing returns the stored epoch. Zero verified compute always allocates zero (tested). | `services/epochs.ts`, `rewards/engine.ts` |
| Customer API keys, usage, request history | Keys are random, shown once, stored as sha256. Usage sums the server's request records. | `services/customers.ts` |
| Operations (`/network`) | Everything is read from the server's records and the in-process event bus. | `app/api/network/ops` |

## Simulated

| Area | Notes | Where |
| --- | --- | --- |
| Network size (12,842 GPUs), memory (68.4 TB), inferences, req/s, uptime, capacity index | Demo baseline with small random drift. Real nodes are added on top. | `services/mock/mockData.ts` |
| Device-class cluster sizes and median scores | Demo. Medians are loosely calibrated against one real M4 Max measurement. | `mockData.ts → deviceClasses` |
| Background job stream, event feed (non-green rows), topology particles | Deterministic generator. Job ids < 5,000,000 are simulated, and any of them renders a consistent detail page. | `services/mock/mockNetwork.ts`, `network/realtime/sources.ts` |
| Compute die (home hero, /brain, /earn) | 1 cell = 1 node from the simulated count. Cell activity is ambient, sampled at the simulated req/s. Real nodes on this server rise as labelled pillars (orange = you, green = others) driven by real join/verify events. | `components/network/ComputeDie.tsx` |
| Explorer job chain | Built from the same job stream. | `components/explorer/JobChain.tsx` |
| Money-flow Sankey on /rewards | Ribbon widths are today's simulated dollars; the split percentages are the real config. `/economics` itself is REAL only. | `components/economics/MoneyFlow.tsx`, `rewards/config.ts` |
| Demo controls on `/demo` (SMALL / MEDIUM / LARGE, units per node, redundancy) | Change the real job that is created. They never change timing or results; processing time is whatever the GPUs take. | `components/demo/DemoScreen.tsx` |
| Model pools (Qwen 32B, DeepSeek Distill, Embeddings, Vision) | Demo. No LLM runs on the browser network in V1. | `mockData.ts → modelPools` |
| Creator rewards, compute payouts, inference revenue (today/7d/30d/all) | Demo. **Not connected to any wallet or billing.** | `mockData.ts → revenue` |
| Token price (`BRAIN $0.001842`) | Demo, not market data. | `mockData.ts → token` |
| Top contributors | Demo rows with anonymous ids. | `mockData.ts → topContributors` |
| Network tape under the hero (GPUs online, memory, req/s, pool sizes, token price) | Demo, pinned with a SIM badge. The REAL metrics strip directly below it reads `/api/stats`. | `components/home/Ticker.tsx` |
| Pro and Max plan prices | Configuration placeholders (`BRAIN_PLAN_PRO_USD`, `BRAIN_PLAN_MAX_USD`). Not purchasable; labelled PLACEHOLDER on `/pricing` and `/account`. | `lib/plans.ts` |
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

- A `ComputeReceipt`, `AccountingEvent`, `ComputeOrder`, `CreatorRewardTreasury`, `RewardEpochV2`, `Account` and `CreditEvent` each carry `source: "REAL" | "SIMULATED"`. Stores index on it, snapshots filter on it, and the test suite asserts that SIMULATED data cannot enter REAL totals, that a SIMULATED earning can never offset credits, that clients cannot self-report earnings or verified compute, and that zero verified compute yields zero reward.

## Never claimed

- No TFLOPS or VRAM figures.
- No fabricated benchmark results. Every score shown for *your* device was measured in your tab and verified by the server.
- No "X% cheaper" comparisons.
- No token emissions, no staking yield, no price expectations.
- LLM inference on the browser network exists in one form only: NETWORK mode in `/chat` runs a Qwen3 model (0.6B–4B depending on who is online), pipeline-sharded by layers across contributor nodes with every layer, the embedding and the output head on nodes (see the row above). It reports its real token rate, the model it actually ran on, and is never mixed with upstream answers. Without the relay configured (`BRAIN_RELAY_URL`/`BRAIN_RELAY_SECRET`) the mode reports no capacity rather than falling back to anything. The verification jobs (integer matmul) remain what they are and say so.
- No cryptographic proof of execution. The receipt hash is an integrity digest; attestation is marked `none` until it exists.
- No revenue, customers or savings that are not in the accounting records. Unpriced work is UNKNOWN, not estimated.
- No subscription that can be bought until a payment rail exists. No privacy guarantee beyond the routing rule in `ROUTING.md`.
- No "verified" label on an upstream model response.
