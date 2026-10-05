# BRAIN AUTO routing

How a request is turned into a route. Source: `engine/router.ts`, `engine/plan.ts`, `engine/providers.ts`, `engine/orders.ts`. Tests: `engine/router.test.ts`, `engine/orders.test.ts`.

## Inputs

- The request (`ExecutionRequest`): chat messages or a compute workload, optional `model` hint.
- `mode`: `AUTO` (default) · `CHEAP` · `FAST` · `QUALITY` · `BROWSER_ONLY`. Legacy aliases still accepted: `CHEAPEST → CHEAP`, `FASTEST → FAST`, `BALANCED → AUTO`, and the old `priority` field.
- `privacy`: `PUBLIC` · `STANDARD` (default) · `PRIVATE`.
- `maxCost` (USD), `maxLatency` (ms), both optional.

## Step 1: classify

`classify(request)` returns the capability the request needs (`chat`, `embeddings`, `compute.matmul_u32`), whether it carries plaintext a node could read, and a size hint. Chat carries plaintext. Verified matmul workloads use seeded synthetic matrices and carry none, so privacy rules are not applied to them.

## Step 2: estimate

Each provider answers independently and never sees the others' numbers.

| Field | Browser network | Upstream (cloud / external) |
| --- | --- | --- |
| `supported` | capability ∈ provider capabilities | env configured and capability ∈ `chat`/`embeddings` |
| `available` | ≥ 1 node online with a verified benchmark | configured |
| `estimatedCost` | list price × units, or `null` if no price | configured per-1M price × estimated tokens, or `null` |
| `estimatedLatency` | median of same-size completed jobs, or `null` | median of measured samples, or `null` |
| `estimatedReliability` | from recent job pass rate | from recent request success rate (starts at a configured prior) |
| `availableCapacity` | online nodes | `null` (not measured) |
| `model` | `brain/matmul-u32` | configured model id |
| `qualityTier` | `null` for chat (unsupported) | `BRAIN_*_QUALITY_TIER` if set, else `null` |
| `confidence` | number of samples behind the estimate | number of samples behind the estimate |

`null` is rendered as UNKNOWN and penalised in scoring. No estimate is ever filled in by assumption.

## Step 3: hard constraints

Applied before scoring and never traded against score. The reason for each exclusion is kept on the row and returned to the caller.

| Constraint | Rule |
| --- | --- |
| supported / available | must be true |
| `BROWSER_ONLY` | only `BROWSER_NETWORK` |
| privacy | `targetTrust[target] ∈ privacyAllows[privacy]` when the request carries plaintext |
| `maxCost` | `estimatedCost ≤ maxCost` when the cost is known (UNKNOWN cost is not excluded, it is penalised) |
| `maxLatency` | `estimatedLatency ≤ maxLatency` when known |

```
privacyAllows   PUBLIC   → untrusted-distributed, operator, third-party
                STANDARD → operator, third-party
                PRIVATE  → operator
targetTrust     BROWSER_NETWORK, NATIVE_NETWORK → untrusted-distributed
                CLOUD_GPU                      → operator
                EXTERNAL_MODEL                 → third-party
```

## Step 4: score

Lower is better. Costs and latencies are min–max normalised over the eligible rows that have a value.

```
normCost     = (cost − min) / (max − min)              UNKNOWN ⇒ unknownPenalty
normLatency  = (latency − min) / (max − min)           UNKNOWN ⇒ unknownPenalty
relPenalty   = 1 − estimatedReliability
qualPenalty  = 1 − qualityTier                         UNKNOWN ⇒ unknownPenalty
score        = w_cost·normCost + w_lat·normLatency + w_rel·relPenalty + w_qual·qualPenalty
```

| Mode | cost | latency | reliability | quality | unknownPenalty |
| --- | --- | --- | --- | --- | --- |
| `AUTO` | 0.40 | 0.25 | 0.25 | 0.10 | 0.75 |
| `CHEAP` | 0.80 | 0.05 | 0.15 | 0 | 1.00 |
| `FAST` | 0.05 | 0.80 | 0.15 | 0 | 1.00 |
| `QUALITY` | 0.05 | 0.05 | 0.30 | 0.60 | 1.00 |
| `BROWSER_ONLY` | as `AUTO`, after the hard filter | | | | |

Ties break on higher `confidence`. The ranked list, weights, per-row penalties and the plain-language reason are stored on the `RouteDecision` and shown on the receipt and in "HOW BRAIN RAN THIS".

## Step 5: execute with fallback

The selected provider runs the step. If it fails before producing output, the next eligible row is tried, and every attempt is recorded on the decision. For streaming chat, fallback is possible only before the first byte; after that the stream belongs to the client and a failure is reported as an error event with the `brain` summary attached. If no row is eligible, the API returns `503 no_provider_available` with every target's exclusion reason. BRAIN never answers from a target it did not select, and never invents an answer.

## Compound plans

`compoundPlan(steps, dependencies)` validates a DAG; `executePlan()` runs it in topological waves, injecting each step's result into dependants (`withContext`) and skipping dependants of a failed step. `planTotalCost()` is UNKNOWN if any step's cost is UNKNOWN. Nothing in production emits a compound plan yet; the primitives are tested so the first multi-step workload does not require a redesign.

## Learning

`observeRoute()` records mode, selected target, estimate and outcome. It is a recorder only. Weight adaptation will be considered once there are enough REAL observations to evaluate against; until then the weights above are static and published.

## What the router does not do

- Guess a price, a latency or a quality tier.
- Prefer a target for business reasons; only the published weights and the request's constraints apply.
- Claim that an upstream model response was verified. Only browser-network work is `VERIFIED`.
- Compare BRAIN's prices with other vendors.
