# Receipts

Every completed job produces a receipt. The receipt is the unit of trust in BRAIN: it says what ran, where, how long it took on the coordinator's clock, how it was verified, and what it cost. Payment flows from receipts and from nothing else.

## Two receipt families

**Compute receipts** (`/receipt/<id>`) are issued when a distributed browser job or a routed chat request settles. Fields are copied from server records: nodes used, verified / failed / reassigned units, compute units, latency, verification method and confidence, `resultHash`, `attestation`.

**Coordinator receipts** are issued for GPU-node inference jobs and are signed. The canonical body is:

```
v, jobId, nodeId, model, inputTokens, outputTokens,
executionMs, timestamp, requestHash, responseHash, hardwareClass, cost
```

It is serialised with sorted keys, hashed with sha256, and signed with the coordinator's ed25519 key. The public key is served at [`/api/coordinator/signer`](https://brainnetwork.app/api/coordinator/signer). `verifyReceipt()` checks any receipt offline, without talking to the database.

## Checking and exporting receipts

* **One receipt, no account:** `GET /api/receipts/<id>/verify` returns the canonical body, the stored hash, the hash recomputed now, the signature and the signer key, plus `valid: true|false` with a reason. Unsigned receipts (browser pool, upstream providers) say `signed: false`.
* **In a response:** every `/v1/chat/completions` response that produced a receipt carries `x-brain-receipt` (the id) and `x-brain-receipt-url` (the verify URL). Store them with your logs.
* **Your whole history:** `GET /v1/receipts?from=&to=&format=csv&verify=1` with your API key returns your own requests and their receipts for the window, as JSON or CSV, with each signature re-checked at read time if you ask. Money fields are `null` where no price applied; they are never zero in place of unknown.
* **In the explorer:** the search box on [/explorer](https://brainnetwork.app/explorer) takes a job id, a receipt id (`r-…`) or a node id (`N-…`).

## What a receipt says about money

| Field | Meaning |
| --- | --- |
| `customerCost` | What the request cost at the configured list price. `null` → **UNKNOWN** when no price is configured. |
| `providerCompensation` | The provider share at list price. `null` when unpriced. |
| `protocolRevenue` | The protocol share at list price. `null` when unpriced. |
| `basis` | `list-price`: owed at list price, nothing collected. Priced receipts never claim payment happened. |

{% hint style="warning" %}
A receipt with a cost on it is a statement of what was *owed at list price*. It is not a statement that money moved. Money that moved is in the settlement records and on-chain: see [Treasury and runway](../economics/treasury-and-runway.md).
{% endhint %}

## What a receipt says about verification

The `verificationMethod` field is literal:

* `spot-check`, `canary` — browser work; server recomputed secret parts; `verified: true`.
* `node-reported` — GPU-node inference; coordinator checked hash, stream, plausibility and clock but did not re-run the model; `verified: false`.
* `unverified-provider-response` — an upstream model answered; `verified: false`.

`verificationConfidence` is a number from the checks that actually ran, not a vibe.

## Receipts and pay

A receipt does two things in settlement:

1. If priced, it accrues `COMPUTE_PROVIDER_EARNED` in the USD accounting ledger for the node that did the work. That ledger shows **accrued** (owed at list price) and **settled** (backed by a transaction reference, currently 0) as two separate numbers.
2. Regardless of price, the completed job becomes a `WorkRecord` in the current hourly epoch. Units are `parameters × tokens ÷ 2²⁰` for language-model work and the kernel's integer operations for browser work. That is what the SOL pool is split by.

Probes (benchmark, canary, shadow) issue no receipt and create no work record. Mock models produce no work. A shadow mismatch re-records the primary as `replica-dispute`, which is lost, unpaid work.

## Anchoring

Anchoring a batch hash of receipts on Solana so that the coordinator's history cannot be rewritten after the fact is **PLANNED**. Until it ships, receipts are verifiable against the coordinator's published key and against the database, and nothing on the site claims more.
