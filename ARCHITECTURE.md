# Architecture

BRAIN is one Next.js application: pages, API route handlers, and the server-side services behind them. There is no separate worker process yet. This document covers the system as it exists after Phase 2. Marketing surfaces (`/`, `/brain`, `/inference`) are not described here; see `README.md`.

```
browser nodes (/node)  ──register/join/heartbeat/pull/complete──▶  services/nodes.ts
                                                                   services/distributed.ts   (split, assign, verify, reassign, settle)
customers (/auto, /v1) ──orders / chat──▶ engine/orders.ts ──▶ engine/providers.ts ──▶ browser network | cloud fallback | external
                                                │                        │
                                                ▼                        ▼
                                         engine/router.ts        services/receipts.ts ──▶ services/accounting.ts
                                                                         │
operators ──admin token──▶ services/customers.ts · services/epochs.ts · services/treasury.ts
                                                                         ▼
                                                               services/store.ts  (MemoryStore | PgStore)
                                                               services/eventBus.ts ──SSE──▶ every open page
```

## 1. Trust model

The server is authoritative for everything that has value. The browser is assumed adversarial.

| Client may send | Server does with it |
| --- | --- |
| Benchmark result | Recomputes secret-seeded blocks, scores on its own clock, ignores client timing |
| Work-unit output (row hashes) | Spot-checks `sampledRows` secret rows, or compares redundant replicas, or checks a canary unit; marks the unit `verified` / `mismatch` |
| GPU name, device class | Stored for display only; never affects credit or routing |
| Heartbeats | Counted; uptime = observed ÷ expected |
| Anything about earnings, compute units, reputation | Ignored. These are derived from server records only (tests: "clients cannot self-report earnings / verified compute") |

Node identity is a persistent anonymous id plus a secret the browser keeps; the server stores only its hash. A browser can reclaim its id; nobody else can.

## 2. Distributed jobs (Phase 1)

`services/distributed.ts`

1. `createJob({ size, unitsPerNode, redundancy })` splits a `u32` matrix multiplication (`lib/config.ts → distributed.sizes`) into `min(maxUnits, liveNodes × unitsPerNode)` row-block units. Each unit is stored as a normal `StoredJob` with `parentId` and `unitId` (`5000001-A`), so the existing pull / verify / reputation path applies unchanged.
2. Nodes pull units through the contributor engine (`network/client/contributor.ts`), run `webgpu/kernels` and return one hash per output row.
3. Verification recomputes secret rows server-side. Confidence for a spot check is \(1 - 0.75^{\text{rows}}\) against a 25 % skipper; redundancy 2 also compares replicas.
4. A unit on a node that stops heart-beating (`nodes.offlineAfterMs`) is marked `lost` and re-queued on another node; `totals.reassigned` increments. `reapStale()` (called from the offline sweep) also fails orphaned units and jobs past `jobTtlMs`.
5. `settle()` runs when no unit is outstanding: status `completed` or `failed` (with `failReason`), `totals` filled from unit records, `job_completed` published, **and a receipt issued** (Phase 2).

Job ids ≥ 5 000 000 are real; smaller ids belong to the simulated explorer stream.

## 3. Proof of compute

`services/receipts.ts` issues one `ComputeReceipt` per terminal job (`r-<jobId>`) or per routed chat request. Fields come from server records only. `resultHash = sha256("brain-receipt-v1|jobId|index:replica:hashes…")` over verified unit outputs in deterministic order; it lets anyone with the same outputs recompute the digest. It is **not** an attestation: `attestation: { kind: "none" }` is reserved for signatures / anchoring later.

`verificationMethod` is one of `spot-check`, `redundant+spot-check`, `canary`, or `unverified-provider-response` (upstream LLM answers are not verified and say so). `verificationConfidence` is the mean unit confidence.

Money fields are `null` unless a list price is configured (`lib/pricing.ts`); priced receipts carry `basis: "list-price"`.

## 4. Accounting

`services/accounting.ts` stores `AccountingEvent`s (`CUSTOMER_PAYMENT`, `COMPUTE_PROVIDER_EARNED`, `PROTOCOL_REVENUE`, `INFRASTRUCTURE_COST`, `CREATOR_REWARD_RECEIVED`) with `source` and `settlement: "accrued" | "settled"`. `accrueReceipt` writes the split from `rewards/config.ts → inferenceRevenue` (60 % providers by verified units, 30 % buyback/protocol, 10 % infrastructure) only for priced receipts. `snapshot(source, from, to)` sums per cell; the source key is part of the store index, so REAL and SIMULATED cannot be summed together.

## 5. BRAIN AUTO

```
ExecutionRequest ─▶ providers.estimate() ×3 ─▶ router.scoreEstimates(mode) ─▶ execute(best) ─▶ receipt
                                                 │ reject: unsupported / over budget / unhealthy
                                                 └ fallthrough to next eligible target on failure
```

- `engine/providers.ts`: `BrowserNetworkExecutionProvider` (estimate = list price × units, latency = median of same-size completed jobs, capacity = live nodes; execute = `createJob` then poll to terminal) and `UpstreamExecutionProvider` for `cloud-fallback` and `external` (wrap the OpenAI-compatible provider; price and latency from config and `engine/metrics.ts` samples).
- `engine/router.ts`: min-max normalises known cost and latency across eligible estimates, assigns `unknownPenalty` to unknowns, and scores `w_cost·cost + w_latency·latency + w_reliability·(1 − reliability)` (lower wins). Modes: `AUTO`, `CHEAPEST`, `FASTEST`, `BROWSER_ONLY`; `priority` on the public API maps `cheap → CHEAPEST`, `fast → FASTEST`, `balanced → AUTO`.
- `engine/orders.ts`: `ComputeOrder` state machine `PENDING → ROUTED → EXECUTING → COMPLETED | FAILED | REJECTED`, with the `RouteDecision` stored and linked from the receipt.

## 6. Reputation, capacity, epochs, treasury, customers

- `services/nodeProfile.ts`: `NodeReputation` from job and heartbeat records; `nodeEconomics` for the contributor block on `/economics` (customer-funded vs subsidized units, accrued earnings, finalized creator rewards, dry-run reward weight for the open epoch).
- `services/capability.ts`: `AVAILABLE / LIMITED / UNAVAILABLE / EXPERIMENTAL` per workload from live nodes, recent outcomes and provider config.
- `rewards/engine.ts`: `allocate(inputs, pool)` → eligibility (min reputation, min reliability, verified compute > 0) → `holdingMultiplier = min(1 + α·ln(1 + share/cap), max)` × `qualityMultiplier = reputation × reliability` × verified compute → per-**account** water-filled cap (`maxAccountShare`, lifted when accounts × cap < 1).
- `services/epochs.ts`: `finalizeEpoch` measures nodes, allocates, writes once (`<epochId>-v2`) with an allocation hash; `verifyEpochHash` recomputes it.
- `services/treasury.ts`: `CreatorRewardTreasury` fed by adapters. `mock` (SIMULATED), `manual` (operator-recorded receipt with transaction reference), `pumpfun` (not implemented; reports so).
- `services/customers.ts`: customers, hashed API keys, per-customer rate limits, request records and usage. `BRAIN_API_KEYS` still works as a legacy single customer.

## 7. Storage and realtime

`services/store.ts` defines `NetworkStore`; `MemoryStore` is a `globalThis` singleton (self-healing across HMR), `PgStore` is selected when `DATABASE_URL` is set (`db/schema.sql`). Phase 2 records use one generic indexed collection: `putDoc / getDoc / listDocs / findDocByKey` with `kind ∈ receipt | accounting | order | decision | customer | apikey | request | treasury | epochv2 | metric`, `key` (usually the source) and `at` for range queries; Postgres table `brain_documents`.

`services/eventBus.ts` is in-process pub/sub with a 200-event history, fanned out by `/api/network/stream` (SSE). Pages use `network/realtime/real.ts` (REAL store: nodes, jobs, summary, feed) and poll `/api/network/real` every 4 s as a backstop.

Consequences: one server process per deployment for the demo; a second instance would not see the first's nodes or events. Without Postgres, a restart loses everything.

## 8. HTTP surface

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/nodes/register · join · heartbeat · leave`, `GET /api/jobs/pull`, `POST /api/jobs/complete` | node session token | contributor protocol |
| `GET/POST /api/jobs`, `GET /api/jobs/[id]` | optional `BRAIN_DEMO_TOKEN` | distributed jobs (detail falls back to parent jobs and returns `receiptId`) |
| `GET/POST /api/orders`, `GET /api/orders/[id]` | optional demo token | compute market |
| `GET /api/receipts`, `/api/receipts/[id]` | public | receipts (+ job + decision) |
| `GET /api/nodes/[id]` | public | profile, recent jobs, economics |
| `GET /api/capacity · /api/economics · /api/network/ops · /api/network/real · /api/network/stream` | public | read models |
| `GET/POST /api/epochs`, `/api/epochs/[id]`, `GET/POST /api/treasury`, `/api/customers` | `BRAIN_ADMIN_TOKEN` for writes | operator |
| `POST /v1/chat/completions` (`priority` extension), `/v1/embeddings`, `GET /v1/models`, `/v1/usage` | customer key, or open + rate limited | customer API; non-stream chat returns `x-brain-receipt` |

## 9. Tests

`npx vitest run` — 11 files, 89 tests: workloads, verification, gateway router, reward formula v1, reward engine v2 (incl. sybil cap), routing scores, orders with fallthrough, settlement, and the economy invariants (receipt reproducibility, unpriced ⇒ no money, SIMULATED never in REAL, no client self-reporting, immutable epochs, zero compute ⇒ zero reward).
