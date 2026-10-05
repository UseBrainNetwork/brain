# Economics

How value moves through BRAIN, what is implemented, and what is deliberately not. Every statement below about "real" numbers refers to records on the running server; see `REAL_VS_SIMULATED.md` for the labeling rules.

## Thesis

Anyone can provide compute. Anyone can buy intelligence. BRAIN finds the cheapest valid way to execute a request and pays the people whose hardware did the verified work.

## Two inflows, one ledger

| Inflow | Source of truth | Status |
| --- | --- | --- |
| Customer payments for executed work | `AccountingEvent CUSTOMER_PAYMENT` | **Accrued only.** Created when a receipt is priced (operator list price). No payment rail exists yet, so `settled` is always empty. |
| Pump.fun creator rewards | `CreatorRewardTreasury` receipts via adapters | **Manual only.** The `manual` adapter records a receipt an operator posts with a transaction reference. The `pumpfun` adapter is not implemented and says so. The `mock` adapter is SIMULATED and cannot touch REAL totals. |

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

BRAIN AUTO scores targets on cost, latency and reliability per mode (`AUTO`, `CHEAPEST`, `FASTEST`, `BROWSER_ONLY`). Unknown cost or latency is penalised, not assumed. The decision, including rejected targets and the reason, is stored and linked from the receipt, so a customer can see why the browser network (or an upstream) was chosen.

## What is not implemented, on purpose

- Billing, invoices, card or on-chain payment collection.
- Live market pricing or auctions (orders are fixed-price-or-UNKNOWN).
- Token emissions, staking, passive yield, governance, NFTs, licenses, points, quests, referrals.
- Buyback execution.
- Any projection of revenue, token price or returns.

## Dashboard reading guide

- **Accrued**: owed at list price for verified work. Nothing moved.
- **Settled**: backed by a transaction reference. Currently only manual treasury receipts can be settled.
- **NOT ENOUGH DATA**: no REAL events in the window.
- **UNKNOWN**: a price that is not configured.
- **AWAITING DATA**: a flywheel stage whose real metric does not exist yet.
