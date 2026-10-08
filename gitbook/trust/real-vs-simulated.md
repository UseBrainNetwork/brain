# Real vs simulated

The site badges every number. This page is the summary; the full table lives in [`REAL_VS_SIMULATED.md`](https://github.com/UseBrainNetwork/brain/blob/main/REAL_VS_SIMULATED.md) in the repository and is the source of truth.

| Badge | Meaning |
| --- | --- |
| **LIVE** | Measured or verified by this server |
| **SIM** | Demo data, shown only when you turn it on |
| **EST** | An illustrative estimate from the real formula with simulated inputs |

**Default is real only.** Out of the box the site shows nothing simulated. Sections whose figures exist only in the model say so instead of showing a number. The footer control "Show simulated data" blends a simulated network in for people who want to see how the product reads at scale; every such figure gets a SIM badge; the setting lives in your browser and changes nothing on the server.

## Real

GPU detection (each field with its source; VRAM always unavailable). Benchmarks (server-seeded, server-timed). Node registration, join, heartbeat, offline sweep. Distributed jobs and their verification. Jobs completed, verified compute, reputation. The real-nodes table and every job with id ≥ 5,000,000. Wallet connection and signature verification. Token holdings when RPC is configured. The reward formula. The inference gateway and router. `/chat` and every field under "how BRAIN ran this". Accounts, plans, credits. Upstream provider cost. Epoch settlement. Claims and payouts. Network inference in NETWORK mode. Receipts and every money field on them (null rendered UNKNOWN when unpriced). Accounting and `/economics`. Node reputation pages. BRAIN AUTO estimates and traces. Capability labels. The treasury, rebuilt from chain. GPU-node registry, jobs, receipts, probes, earnings. The request-path animation on `/network` (every pulse is a real job).

## Simulated

Only when "Show simulated data" is on: a demo network size, memory and request rate; device-class cluster sizes; a background job stream (ids below 5,000,000); explorer job chain; money-flow ribbons on `/rewards`; model pools; demo revenue figures; a demo token price; demo top contributors; the network tape under the hero. Epoch history for a wallet with nothing settled is a labelled demo and never claimable.

## Estimated

The reward multiplier and earnings estimates on `/earn` and the calculator run the real formula against the simulated network and pool, labelled EST; nothing is paid from them. "This epoch accrued" is your real verified work against the last live pool, pro-rated to elapsed time, and becomes real only when the epoch settles. Inference prices show `$X.XX` until cost benchmarks exist.

## Never mixed

A `ComputeReceipt`, `AccountingEvent`, `ComputeOrder`, `CreatorRewardTreasury`, `RewardEpochV2`, `Account` and `CreditEvent` each carry `source: "REAL" | "SIMULATED"`. Stores index on it, snapshots filter on it, and the test suite asserts that SIMULATED data cannot enter REAL totals, that a SIMULATED earning can never offset credits, that clients cannot self-report earnings or verified compute, and that zero verified compute yields zero reward.

## Never claimed

No TFLOPS or VRAM figures. No fabricated benchmark results. No "X % cheaper" comparisons. No token emissions, staking yield or price expectations. No cryptographic proof of execution where there is an integrity digest. No revenue, customers or savings that are not in the accounting records. No subscription that can be bought until a payment rail exists. No "verified" label on an upstream model response.
