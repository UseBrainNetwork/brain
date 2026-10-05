# BRAIN architecture

BRAIN is one product with two entrances built on one network.

| Name | What it is | Where |
| --- | --- | --- |
| **BRAIN** | The consumer product: ask once, get the best available answer, see how it ran. | `/chat`, `/pricing`, `/account` |
| **BRAIN NETWORK** | The compute fabric: browser nodes today, native nodes later, operator cloud and third-party models as resource classes. | `/network`, `/explorer`, `/capacity`, `/demo`, `/node` |
| **BRAIN AUTO** | The routing engine. Classifies a request, estimates every resource class, selects, executes, verifies, falls back, and issues a receipt. | `engine/` |
| **POWER BRAIN** | The contributor product: your computer runs verified work for the network and earns from it. | `/earn` (alias of `/contribute`), `/node` |
| **BRAIN RECEIPT** | The proof. Every executed request ends in a receipt that records nodes, verification, cost, and the route decision. | `/receipt/[id]`, `services/receipts.ts` |

Everything below describes what runs today. Where a component is a placeholder, it says so.

## Request flow

```
REQUEST ─▶ CLASSIFY ─▶ PLAN ─▶ ESTIMATE ─▶ SELECT ─▶ EXECUTE ─▶ VERIFY ─▶ MERGE ─▶ RESPONSE ─▶ RECEIPT ─▶ LEARN
            plan.ts    plan.ts  providers   router.ts  providers  per-target   orders.ts  stream /    receipts   learning.ts
                                 .estimate  score      .execute   (see below)             JSON        + ledger   (recorder only)
```

1. **REQUEST.** `/api/chat` (consumer, cookie account) or `/v1/chat/completions` (developer, API key) or `/api/orders` (compute). Both chat paths accept `mode`, `privacy`, `maxCost`, `maxLatency`.
2. **CLASSIFY.** `classify(request)` → `{ capability, carriesPlaintext, sizeHint }`. Chat carries plaintext; seeded matmul workloads carry none, so privacy rules do not apply to them.
3. **PLAN.** `plan()` produces a single-step `ExecutionPlan`. `compoundPlan()` validates multi-step plans with dependencies; `executePlan()` runs them in topological waves, passing each step's output into dependants and skipping dependants of a failed step. Nothing in production creates a compound plan yet; the primitives exist and are tested so the next workload can use them without a rewrite.
4. **ESTIMATE.** Every `IntelligenceProvider` returns an `ExecutionEstimate` for the step: `supported`, `available`, `estimatedCost`, `estimatedLatency`, `estimatedReliability`, `availableCapacity`, `model`, `qualityTier`, `confidence`, plus the basis for each number. Anything not measured or configured is `null` (rendered UNKNOWN), never guessed.
5. **SELECT.** `scoreEstimates()` applies hard constraints (supported, available, BROWSER_ONLY, maxCost, maxLatency, privacy) then scores the eligible rows with the weights of the requested mode. See `ROUTING.md`.
6. **EXECUTE.** The selected provider runs the step. Streaming chat hands the upstream byte stream to the caller while a tap accumulates the final text and usage. If execution fails before the first byte, the next eligible target is tried; the decision records every attempt.
7. **VERIFY.** Browser-network work is verified by secret spot-check or canary and is the only path that can be marked `VERIFIED`. Upstream model responses are `unverified-provider-response` and say so on the receipt and in the UI (`VERIFIED: NO`).
8. **MERGE.** Verified units are reassembled in order (compute) or the stream is reframed into the OpenAI shape (chat). `reframeStream` whitelists fields, so vendor names and upstream prices never reach the client.
9. **RESPONSE.** Chat: SSE tokens → `event: brain` (the run summary) → `data: [DONE]`. JSON: the `brain` object and an `x-brain-receipt` header.
10. **RECEIPT.** `ComputeReceipt` with `route`, `planId`, `stepId`, cost (list price for the customer, provider-reported cost when the upstream returns one), verification method and confidence. Accounting events are accrued from it; credits are consumed from it.
11. **LEARN.** `observeRoute()` records (mode, target, estimate vs outcome). It is a recorder only; nothing adapts weights yet.

## Resource classes

| Class | Provider | Trust | Status today |
| --- | --- | --- | --- |
| `BROWSER_NETWORK` | `BrowserNetworkExecutionProvider` | `untrusted-distributed` | **Real.** WebGPU nodes run `compute.matmul_u32`; results verified server-side. Does not run chat. |
| `NATIVE_NETWORK` | `NativeNetworkExecutionProvider` | `untrusted-distributed` | **Not built.** Always `supported: false`, reason `UNCONFIGURED`. Present so the estimate table is complete, not to imply capacity. |
| `CLOUD_GPU` | `UpstreamExecutionProvider("cloud-fallback")` | `operator` | Real when `BRAIN_FALLBACK_*` is set; unavailable otherwise. Not configured in production. |
| `EXTERNAL_MODEL` | `UpstreamExecutionProvider("external")` | `third-party` | **Real.** OpenRouter (`meta-llama/llama-3.1-8b-instruct`) in production. Reports its own cost per request, recorded as `INFRASTRUCTURE_COST` with basis `provider-reported`. |

`/capacity` derives a state per capability from these providers plus live measurements: `UNAVAILABLE` if unconfigured, `LIMITED` if configured but unmeasured or below 90 % reliability, `AVAILABLE` otherwise. "Configured" is never shown as "demonstrated".

## Privacy

| Level | May execute on |
| --- | --- |
| `PUBLIC` | browser crowd, operator cloud, third-party models |
| `STANDARD` (default) | operator cloud, third-party models |
| `PRIVATE` | operator cloud only |

Enforced as a hard constraint in the router; the API returns `503 no_provider_available` with the per-target exclusion reasons when nothing qualifies. Because `CLOUD_GPU` is not configured in production, `PRIVATE` currently returns 503 there. The pricing page lists private routing as a Max-plan feature with the plan itself marked PLACEHOLDER; no privacy guarantee is claimed anywhere beyond this routing rule.

## Accounts, credits, plans

- **Accounts** (`services/accounts.ts`): created on first use of `/chat`; identity is a signed httpOnly cookie (`accountId.exp.hmac`, keyed by `BRAIN_SERVER_SECRET`). A wallet can be attached by signing a nonce; that links the account to the nodes it powers. No passwords, no email.
- **Plans** (`lib/plans.ts`): FREE ($0, live), PRO ($10, placeholder), MAX ($25, placeholder). Prices and allowances are env-configurable. `paymentsConnected()` is `false`, so Pro and Max cannot be bought and are labelled PLACEHOLDER wherever they appear.
- **Credits** (`services/credits.ts`): 1 credit = `BRAIN_CREDIT_USD` (default $0.001). Ledger events: `GRANT_INCLUDED` (once per month per account, deterministic id), `CONSUME` (−customerCost / creditUsd; UNKNOWN cost consumes 0 and is flagged), `COMPUTE_OFFSET` (REAL `COMPUTE_PROVIDER_EARNED` events for nodes the account's wallet powers, mirrored once each), `PURCHASE` (reserved; never written). `/api/chat` returns `402 out_of_credits` at zero on the Free plan.
- **Account dashboard** (`/account`): YOUR PLAN, SUBSCRIPTION ($0, "payments not connected"), COMPUTE EARNINGS (accrued REAL lines for your nodes), NET = earned − used. Everything here is REAL or NOT ENOUGH DATA.

## Storage

`NetworkStore` → `MemoryStore` (dev) or `PgStore` (Supabase in production). Domain documents live in `brain_documents (kind, id, key, at, data)`, so new kinds (`plan`, `account`, `credit`, `session`) needed no migration. Distributed-job updates are serialized with transaction-scoped advisory locks. The in-process event bus feeds the public SSE stream; `order.updated` is redacted to routing facts, and every public order endpoint goes through `publicOrder()` which strips prompts and outputs.

## Security boundaries

- Provider keys and prices are server-only env; the client bundle has no secret names or values.
- Nothing client-reported is trusted for GPU model, compute units, completion, score or uptime.
- Rate limits per hashed IP and per plan; session and API-key material stored as hashes.
- Public surfaces show 4-hex node ids; wallets, IPs and device names never appear.
- Upstream vendor identity and upstream cost are stripped from streamed chunks; the receipt shows BRAIN's list price and the provider's cost as separate, labelled lines.

## Code map

```
engine/
  providers.ts   IntelligenceProvider + the four resource-class implementations
  router.ts      scoreEstimates, modeWeights, privacyAllows, targetTrust, selectionReason
  plan.ts        classify, plan, compoundPlan, topologicalOrder, withContext, planTotalCost
  orders.ts      placeOrder, placeStreamingOrder, executePlan, publicOrder, getters
  learning.ts    observeRoute, recentObservations
api/
  gateway.ts     validateChat, reframeStream, listModels, authorizeApiKey, GatewayError
  chatStream.ts  chatEventStream (tokens → event: brain → [DONE]), BrainRunSummary
services/
  accounts.ts credits.ts accountSummary.ts   consumer side
  receipts.ts accounting.ts capability.ts    proof and economics
lib/plans.ts     plan config, creditUsd, paymentsConnected
components/chat  ChatApp (POWERED BY BRAIN → HOW BRAIN RAN THIS → receipt)
components/account, app/pricing, app/earn
```

## What is deliberately not here

NFTs, node licenses, governance, quests, XP, staking, APY, a model marketplace, auctions, price predictions, fabricated logos/benchmarks/savings, our own foundation model, distributed LLM inference on the browser pool, and a rebuild of anything that already worked. Items that are placeholders (Pro/Max prices, `NATIVE_NETWORK`, `PURCHASE`) are labelled as such in code and UI.
