# Economics

How value moves through BRAIN, what is implemented, and what is deliberately not. Every statement below about "real" numbers refers to records on the running server; see `REAL_VS_SIMULATED.md` for the labeling rules.

## Thesis

Anyone can provide compute. Anyone can buy intelligence. BRAIN finds the cheapest valid way to execute a request and pays the people whose hardware did the verified work.

## Two inflows, one ledger

| Inflow | Source of truth | Status |
| --- | --- | --- |
| Customer payments for executed work | `AccountingEvent CUSTOMER_PAYMENT` | **Accrued only.** Created when a receipt is priced (operator list price). No payment rail exists yet, so `settled` is always empty. |
| Subscriptions | `AccountingEvent SUBSCRIPTION_PAYMENT` | **Type exists, never written.** Pro and Max are placeholders until payments are connected. `/economics` shows "no payment processor connected". |
| Pump.fun creator rewards | `CreatorRewardTreasury` receipts via adapters | **On-chain.** The `pumpfun` adapter scans the protocol wallet's transactions and records a receipt for every claim: SOL leaving one of our pump.fun creator-fee vault PDAs into the wallet in the same transaction, keyed by signature. Unclaimed fees still in the vault are displayed but are not revenue. The `manual` adapter remains for receipts an operator posts with a transaction reference. The `mock` adapter is SIMULATED and cannot touch REAL totals. |

And one real outflow: when the external model provider reports what it charged for a request, that amount is recorded as `INFRASTRUCTURE_COST` with basis `provider-reported` (OpenRouter returns `usage.cost`). When it does not, the configured `BRAIN_EXTERNAL_PRICE_USD_PER_1M` is used with basis `list-price`; when neither exists, the cost is UNKNOWN.

Both feed the same ledger (`services/accounting.ts`), keyed by `source`. `/economics` shows the REAL ledger and nothing else; empty cells read NOT ENOUGH DATA.

## Splits (configuration, `rewards/config.ts`)

| Pool | Compute providers | Buyback / protocol | Infrastructure | Treasury |
| --- | --- | --- | --- | --- |
| Inference / compute revenue | 60 % | 30 % | 10 % | 0 % |
| Creator rewards | 70 % | 0 % | 20 % | 10 % |

Provider shares of a priced receipt are divided across nodes **by verified compute units** in that job. Buyback is a protocol-revenue line in the ledger; no buyback is executed.

## Prices

There is no market price yet. An operator may set list prices:

- `BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS` for browser-network compute (1 unit = 2²⁰ multiply-accumulates, i.e. m·n·k ÷ 1 048 576 for a matmul unit; `network/workloads.ts`).
- `BRAIN_PRICE_USD_PER_1M_TOKENS` for chat, plus `BRAIN_FALLBACK_PRICE_USD_PER_1M` / `BRAIN_EXTERNAL_PRICE_USD_PER_1M` for what each upstream costs us.

Unset means `UNKNOWN` on receipts, estimates and dashboards. Nothing interpolates a price, and no comparison against other providers is shown.

### Current production list prices (set 2026-10-04)

- Compute: `BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS=0.00000005` ($0.05 per 1B units). Derivation: 1k units ≈ 2.1 GFLOP. A browser GPU sustaining ~2 TFLOPS in WebGPU does ~3.4M k-units/hour, so this price values a contributor device at ≈ $0.17 gross per GPU-hour before the split — the floor of the consumer-GPU rental market, and roughly 10× datacenter cost per FLOP, which is the honest overhead of redundant, verified browser execution. A typical demo job (4,096 units) prices at $0.0000002.
- Chat: `BRAIN_PRICE_USD_PER_1M_TOKENS=0.20`, routed through OpenRouter (`meta-llama/llama-3.1-8b-instruct`), whose published completion price is `BRAIN_EXTERNAL_PRICE_USD_PER_1M=0.08` (prompt $0.05). Margin on routed chat is therefore list minus upstream, recorded per request.
- Embeddings remain unconfigured (OpenRouter does not list embedding models), so `/v1/embeddings` keeps returning `no_provider_available`.

## Plans and BRAIN Credits (`lib/plans.ts`, `services/credits.ts`)

A credit is a unit of real cost, not a token: `1 credit = BRAIN_CREDIT_USD` (default $0.001). A request consumes `customerCost ÷ creditUsd`, where `customerCost` is the list price on its receipt. UNKNOWN cost consumes nothing and is counted in `unknownCostRequests`; the account page shows that count.

| Plan | Price | Included credits / month | Modes | Private routing | Status |
| --- | --- | --- | --- | --- | --- |
| Free | $0 | `BRAIN_PLAN_FREE_CREDITS` (500 ≈ $0.50 of routed requests) | AUTO, CHEAP | no | **Live** |
| Pro | `BRAIN_PLAN_PRO_USD` (10) | `BRAIN_PLAN_PRO_CREDITS` (12 000) | all | no | **Placeholder** |
| Max | `BRAIN_PLAN_MAX_USD` (25) | `BRAIN_PLAN_MAX_CREDITS` (35 000) | all | yes | **Placeholder** |

`paymentsConnected()` is `false`: Pro and Max cannot be purchased, their prices are proposals, and every surface that shows them says PLACEHOLDER. Included credits are granted once per calendar month per account (deterministic ledger id, so retries cannot double-grant). The Free plan stops at zero with `402 out_of_credits`.

Ledger event types: `GRANT_INCLUDED`, `CONSUME`, `COMPUTE_OFFSET`, `PURCHASE` (reserved, never written).

## Pay with compute

If an account attaches the wallet that its nodes verified with, every REAL `COMPUTE_PROVIDER_EARNED` event for those nodes is mirrored once as a `COMPUTE_OFFSET` credit (`earnedUsd ÷ creditUsd`). SIMULATED earnings are rejected by the ledger. The account page shows `NET = earned − used`; it is a ledger primitive, nothing is paid out and nothing is charged. This is the whole of "pay with compute" today, and it is the mechanism by which the consumer and contributor sides of BRAIN are one product.

## Receipts

A `ComputeReceipt` is the unit of account: who computed, what was verified, how long it took, what it cost, how the money splits. `customerCost`, `providerCompensation` and `protocolRevenue` are present only when priced, and then carry `basis: "list-price"`. Receipts are REAL or SIMULATED, never both; only REAL receipts are listed publicly.

## Contributor rewards (engine v2, `rewards/engine.ts`)

For each node in an epoch:

\[
\text{weight} = \text{verifiedCompute} \times \underbrace{\min\!\big(1 + \alpha \ln(1 + \tfrac{\min(\text{share},\,\text{cap})}{\text{cap}}),\ M\big)}_{\text{holding multiplier}} \times \underbrace{\text{reputation} \times \text{reliability}}_{\text{quality multiplier}}
\]

with defaults α = 0.5, cap = 1 % of circulating supply, M = 1.35, and eligibility thresholds reputation ≥ 0.35, reliability ≥ 0.5. The pool is split pro rata by weight, then a per-**account** cap (25 %) is water-filled so that sybil-splitting one account into many nodes does not lift the cap. If the cap is unsatisfiable (fewer than four accounts) it is lifted and the epoch says so.

Properties enforced by tests:

- Zero verified compute ⇒ zero reward, whatever the holdings.
- Holdings scale the reward on work done; they are never a yield.
- Multiplier is monotone, capped, and has diminishing returns.
- Cap is per account; shards of the same account share one cap.
- Pool is conserved (allocations sum to the pool, minus rounding).

Epochs (`services/epochs.ts`) are written once with a hash of allocations and can be re-verified. Payouts use the existing claim path (`services/claims.ts`), which stays off until `BRAIN_PAYOUTS_ENABLED=true` and a payout key exist.

## Contributor view (`/economics → Your node`)

| Field | Computed from |
| --- | --- |
| Verified compute | server-verified units credited to the node |
| Customer jobs / Subsidized jobs | units inside receipts that had a `customerCost` vs those that did not |
| Customer-funded earnings | sum of `COMPUTE_PROVIDER_EARNED` events for the node (accrued) |
| Creator-reward earnings | sum of this node's allocations in finalized epochs |
| Token holdings | chain-verified SPL balance ÷ circulating supply, or "no wallet linked" |
| Reward weight | dry-run of the engine over the open epoch |

## Routing economics

BRAIN AUTO scores resource classes on cost, latency, reliability and configured quality tier per mode (`AUTO`, `CHEAP`, `FAST`, `QUALITY`, `BROWSER_ONLY`), with privacy (`PUBLIC`, `STANDARD`, `PRIVATE`), `maxCost` and `maxLatency` as hard constraints. Unknown cost, latency or quality is penalised, not assumed. The decision, including rejected targets and the reason, is stored and linked from the receipt and from "HOW BRAIN RAN THIS" in `/chat`. Weights and rules: `ROUTING.md`.

`/economics` adds: subscription revenue (none), list price per 1M tokens once applied to a real receipt, average customer cost per request, and average upstream cost per chat (what the provider charged BRAIN). Margin is `paid + subscriptions − providers − infrastructure` over revenue.

## What is not implemented, on purpose

- Billing, invoices, card or on-chain payment collection.
- Live market pricing or auctions (orders are fixed-price-or-UNKNOWN).
- Token emissions, staking, passive yield, governance, NFTs, licenses, points, quests, referrals.
- Buyback execution.
- Any projection of revenue, token price or returns.

## Dashboard reading guide

- **Accrued**: owed at list price for verified work. Nothing moved.
- **Settled**: backed by a transaction reference. Treasury receipts (on-chain creator-fee claims and manual records) are settled.
- **NOT ENOUGH DATA**: no REAL events in the window.
- **UNKNOWN**: a price that is not configured.
- **AWAITING DATA**: a flywheel stage whose real metric does not exist yet.
