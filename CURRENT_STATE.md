# CURRENT_STATE

## State after the intelligence-network evolution (2026-10-05)

Phases A–E of the brief are implemented and verified locally (typecheck, build, 102 tests, headless-Chrome screenshots at 1440/390 px, WebGPU detection at `/earn`). Everything in the audit below that was marked NOT IMPLEMENTED, PARTIAL or REDUNDANT has moved as follows:

| Item | Now |
| --- | --- |
| `/chat` | WORKING. Streams through BRAIN AUTO; `POWERED BY BRAIN` expands to `HOW BRAIN RAN THIS` (route, model, nodes, cost, latency, verified, receipt). Mode and privacy pills gated by plan. |
| `/pricing` | WORKING. FREE live; PRO/MAX labelled PLACEHOLDER (payments not connected). Credits explained as a unit of real cost. |
| `/account` | WORKING. YOUR PLAN / SUBSCRIPTION / COMPUTE EARNINGS / NET from REAL records only; credit ledger; wallet attach. |
| `/earn` | WORKING. POWER BRAIN entrance wrapping the existing contribute flow. `/contribute` and `/inference` redirect. |
| Streaming chat | WORKING with receipts and accounting; legacy `providers/router.ts`, `registry.ts`, `/api/playground`, SIM `shardPlan` removed. |
| Provider interface | `IntelligenceProvider { id, type, capabilities, estimate, execute, executeStream?, health }`; four resource classes incl. honest `NATIVE_NETWORK` placeholder. |
| Modes / privacy | `AUTO · CHEAP · FAST · QUALITY · BROWSER_ONLY`; `PUBLIC · STANDARD · PRIVATE` as a hard constraint. Legacy aliases accepted. |
| Plan primitives | `classify → plan → executePlan` with compound-plan DAG support (tested; no production compound plans yet). |
| Learning hook | `observeRoute` recorder, in-memory. |
| Accounts / credits | Signed-cookie accounts, monthly grant, consume from receipts, REAL-only compute offsets, 402 at zero. |
| Capability model | Adds `chat-external`, `chat-cloud`, `embeddings-external` from config + measured reliability. |
| Economics | `SUBSCRIPTION_PAYMENT` type (never written yet), per-request and per-1M cells, provider-reported upstream cost; money lines in the live feed (REAL only). |
| Privacy of public surfaces | Event stream and order endpoints redact prompts and outputs. |
| Holding multiplier form | Unchanged (`rewards/engine.ts` already uses `1 + α·ln(1 + normalizedOwnership)`, capped). |

Still simulated and labelled: hero/marketing tape, `/brain`, model pool statuses, SIM job chain, token price, calculator presets. Still not implemented: payments, payouts (gated off), native nodes, multi-instance event bus, receipt signatures. See `BRAIN_ARCHITECTURE.md`, `ROUTING.md`, `NEXT_30_DAYS.md`.

---

## Audit before the evolution (2026-10-05)

Audit of the codebase before the "intelligence network" evolution (Phase A onward). Statuses: **WORKING** (real, verified end to end), **PARTIAL** (real but incomplete), **SIMULATED** (demo data, labeled SIM), **NOT IMPLEMENTED**, **BROKEN / REDUNDANT**.

## 1. Routes

| Route | Status | Notes |
| --- | --- | --- |
| `/` | WORKING + SIMULATED | Hero die + "One request, traced" are real UI; network totals on the hero are SIM. Needs the two-sided USE/POWER framing and a real-metrics strip. |
| `/contribute` | WORKING | Detect → server-verified benchmark → wallet (optional) → join → dashboard. Real WebGPU. |
| `/node` | WORKING | Full-screen worker; real jobs, real verification, units credited. |
| `/demo` | WORKING | Room view, real node count, RUN TEST JOB across all connected nodes, per-unit lifecycle. |
| `/auto` | WORKING | BRAIN AUTO console: estimates every target, executes cheapest valid, receipt. Compute + chat. |
| `/inference` | PARTIAL | Models list (SIM statuses), playground through the legacy gateway path (no receipt). |
| `/explorer`, `/explorer/job/[id]` | WORKING + SIMULATED | Real jobs tagged live; SIM job chain also rendered, labeled. |
| `/receipt/[id]` | WORKING | Nodes, verification, result hash, cost, route decision. Provider compensation / protocol revenue shown when priced. |
| `/node/[nodeId]` | WORKING | Server-measured reputation. |
| `/network` | WORKING | Five-question ops view, 3 s poll, recent events. Money lines not yet in the feed. |
| `/economics` | WORKING | REAL snapshot, flywheel (7 stages, AWAITING DATA), your node, treasury, pricing config, epochs, accounting events. |
| `/capacity` | WORKING | Capability states derived from real nodes/jobs. Capabilities are compute-centric (matmul sizes); no chat/embeddings-via-provider capability yet. |
| `/rewards`, `/epoch/[id]` | WORKING + SIMULATED | Formula explainer, calculator (EST), epoch history, claims (payouts off by default). |
| `/developers` | WORKING | Quickstart, routing, response format. Imports `defaultRoutingWeights` from the legacy router. |
| `/brain` | SIMULATED | "Network as one machine"; totals and pools are SIM. |
| `/chat`, `/pricing`, `/earn`, `/account` | NOT IMPLEMENTED | |

## 2. WebGPU implementation — WORKING

`webgpu/detect.ts` (every field tagged with its source; unknown = "unavailable"), `webgpu/kernels.ts` (WGSL `mix_u32`, `matmul_u32`), `webgpu/backend.ts`, `webgpu/benchmark.ts`. Integer kernels make GPU results bit-identical to the CPU reference. Fallback paths for missing `navigator.gpu` / null adapter tested.

## 3. Real node system — WORKING

`services/nodes.ts`: register (server recomputes 3 secret blocks of the challenge; score from the server clock), join, heartbeat (offline after 12 s), leave; anonymous 4-hex ids; session hashes only. `network/client/contributor.ts` is the browser engine.

## 4. Job orchestration — WORKING

`services/distributed.ts`: a request → N work units across real nodes, per-unit deadlines, reassignment (max 3 attempts), TTL reaping, locking via `withLock` (in-process KeyedMutex; transaction-scoped advisory locks on Postgres). Verified with 4 nodes incl. kill-mid-job.

## 5. Verification — WORKING

`services/verification.ts`: canary (full known answer, 20 %) or secret spot-check rows (6–8), plausibility bound on ops/ms, reputation EWMA (failures weigh double, ban < 0.35). `compareRedundant` exists; redundancy=2 selectable per request. Expected outputs and sampled indices never leave the server.

## 6. Reward system — WORKING (settlement path), payouts OFF

`rewards/formula.ts` (v1, water-filled under pool cap), `rewards/engine.ts` (v2: holding + quality multipliers, caps), `rewards/config.ts` (every parameter), `services/settlement.ts`, `services/epochs.ts`, `services/claims.ts`, `services/payouts.ts` (SOL transfer, gated by `BRAIN_PAYOUTS_ENABLED`). Tests: tokens alone earn 0; banned/sub-threshold earn 0; Sybil-neutral; capped. Holding multiplier is `√(normCompute·effToken)/(√λ·normCompute)` capped — not yet the `1 + α·log(1 + holdings)` form the new brief asks for; both are configurable and both give zero for zero compute.

## 7. Simulated vs real — WORKING invariant

Every record carries `source: REAL | SIMULATED`; UI badges LIVE / SIM / EST (`Prov`). `services/accounting.snapshot()` filters by source; tests assert SIM never enters REAL totals. All demo data lives in `services/mock/`. Hero/marketing totals are SIM and labeled.

## 8. Database — WORKING

`db/schema.sql`, self-applied on first connection. Tables: nodes, jobs (secret material; never read-exposed), challenges, reward epochs/allocations/claims, distributed jobs, and `brain_documents` (JSONB by kind: receipt, accounting, order, decision, customer, apikey, request, treasury, epoch v2, metric samples). Production: Supabase Postgres (pooled), advisory locks, stale-lock cleanup at boot. In-memory store when no URL.

## 9. Authentication — PARTIAL (by design: not over-engineered)

- Nodes: random session tokens, stored as SHA-256; HMAC with `BRAIN_SERVER_SECRET`.
- Wallets: sign a server nonce, verified ed25519 server-side.
- API customers: hashed API keys (`services/customers.ts`), per-customer rate limits; legacy `BRAIN_API_KEYS`.
- Operator: `BRAIN_ADMIN_TOKEN` bearer.
- **No consumer user accounts**, no subscriptions, no credit balances.

## 10. BRAIN AUTO — WORKING, needs the new shape

`engine/providers.ts` already defines `ExecutionProvider { id, target, estimate, execute, health }` with three providers (browser pool, cloud fallback, external). `engine/router.ts` is a pure scorer over estimates (cost/latency/reliability, unknown penalised, hard constraints). `engine/orders.ts` places a `ComputeOrder`, records a `RouteDecision`, executes with fallback through the ranked eligible list, writes a receipt.

Gaps vs the brief: no `type`/`capabilities` on providers; estimate lacks `model`; modes are `AUTO | CHEAPEST | FASTEST | BROWSER_ONLY` (no QUALITY); no privacy requirement; no classification/plan step; single-step only; no learning hook; `NATIVE_NETWORK` absent.

## 11. API architecture — WORKING, two stacks (REDUNDANT)

- `/v1/chat/completions` non-streaming → `engine/orders.placeOrder` (decision, receipt, accounting). Streaming → **legacy** `api/gateway.chatCompletionStream` via `providers/router.ts` + `providers/registry.ts` (no receipt, no accounting). `/api/playground` also uses the legacy path. `/v1/embeddings` is a passthrough gated on `BRAIN_EXTERNAL_EMBED_MODEL`.
- `brain` response extension carries orderId/decisionId/receiptId/target/provider/latency/cost.
- Production: OpenRouter configured as EXTERNAL; `/v1/chat/completions` returns real replies with priced receipts.

## 12. Economics pages — WORKING

`/economics` snapshot cells (customers paid, providers earned, creator rewards, protocol revenue, infrastructure cost, margin, cost per 1M units). Event types: `CREATOR_REWARD_RECEIVED`, `CUSTOMER_PAYMENT`, `COMPUTE_PROVIDER_EARNED`, `PROTOCOL_REVENUE`, `INFRASTRUCTURE_COST`. Missing: `SUBSCRIPTION_PAYMENT`, cost per job / per embedding cells, settled vs accrued shown but nothing is settled yet (no payment rail).

## 13. `/demo` and `/node` — WORKING

Multi-device demo verified in headless Chrome (4 contexts) and on production with two physical devices (8/8 verified, receipt `r-5000002` persisted).

## Summary

| Category | Items |
| --- | --- |
| WORKING | WebGPU detection/benchmark/kernels; node lifecycle; distributed jobs with reassignment; verification; receipts; reputation; BRAIN AUTO (estimate → select → execute → fallback → receipt); accounting with REAL/SIM isolation; Postgres store with locks; reward settlement + claims (payouts gated); ops view; economics; capacity. |
| PARTIAL | Auth (no consumer accounts); streaming chat (no receipt); capability model (compute-only); provider interface (no type/capabilities/model/privacy); holding multiplier form. |
| SIMULATED | Hero/marketing totals, `/brain` machine view, model pool statuses, SIM job chain, token price, calculator inputs. |
| NOT IMPLEMENTED | `/chat`, `/pricing`, `/earn` (as the POWER BRAIN entrance), `/account`; BRAIN Credits; subscriptions; QUALITY mode; privacy requirement; ExecutionPlan/Step; NATIVE_NETWORK; learning hooks; money lines in the live feed. |
| BROKEN / REDUNDANT | Two routing stacks (`providers/router.ts` legacy vs `engine/router.ts`); `shardPlan` SIM visualisation in the gateway; `/inference` playground bypasses receipts. Nothing is broken at runtime. |

## Evolution plan (what this audit feeds)

Phase A: give providers `type`/`capabilities`/`model`/trust, add `QUALITY` + privacy to the router, add classify → plan primitives, route streaming through BRAIN AUTO with receipts, retire the legacy router. Phase B: `/chat`. Phase C: credits, pricing config, lightweight accounts. Phase D: account ↔ contributor loop. Phase E: economics additions. Phase F: compound plan primitives + tests. See `BRAIN_ARCHITECTURE.md`, `ROUTING.md`, `NEXT_30_DAYS.md`.
