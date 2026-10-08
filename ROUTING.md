# BRAIN AUTO routing

How a request is turned into a route. Source: `engine/router.ts`, `engine/plan.ts`, `engine/providers.ts`, `engine/orders.ts`. Tests: `engine/router.test.ts`, `engine/orders.test.ts`.

## Inputs

- The request (`ExecutionRequest`): chat messages or a compute workload, optional `model` hint.
- `mode`: `AUTO` (default) · `CHEAP` · `FAST` · `QUALITY` · `COMMUNITY` · `BROWSER_ONLY`. Legacy aliases still accepted: `CHEAPEST → CHEAP`, `FASTEST → FAST`, `BALANCED → AUTO`, and the old `priority` field.
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

Requests whose `model` is a Brain Node model id (the allowlist in `node/models.ts`) default to `privacy: PUBLIC`, because those models only run on `NATIVE_NETWORK`. An explicit `STANDARD` or `PRIVATE` on such a request is a contradiction and returns `400 privacy_conflict` rather than being routed to an upstream that happens to have a similarly named model. Upstream providers report `supported: false` for node model ids.

## Node selection inside NATIVE_NETWORK

Once BRAIN AUTO picks `NATIVE_NETWORK` (or the request pins a node model), `services/router/score.ts` picks the node. Pure, deterministic, unit-tested.

```
hard filters   state ONLINE or BUSY with a free slot · serves the model · reported VRAM ≥ model requirement
               (reported VRAM can only exclude, never promote) · region match when required · ask ≤ budget when set
NodeScore      0.30·capability + 0.25·availability + 0.15·latency + 0.20·reputation + 0.10·price
  capability   1.0 if the model is loaded, 0.6 if it must be loaded first; × (0.5 + 0.5 · tok/s ÷ pool max)
               using coordinator-measured speed (then the coordinator benchmark; 0.5 neutral with a note when unmeasured)
  availability (1 − active ÷ slots) · (1 − queue ÷ 4·slots)
  latency      heartbeat RTT: 1 − rtt/300 ms (×0.7) + 0.3 if at or under the pool median; +0.2 for a region match;
               0.5 neutral with a note when unmeasured
  reputation   Brain Reliability Score ÷ 100 (coordinator-computed)
  price        1 − ask ÷ highest ask (scaled 0.2..1); 0.5 neutral with a note when the node sets no ask
tie-break      node id, ascending
no candidate   "0 of N nodes can serve <model> right now (<node>: <reason>; …)"
```

The reason string is stored on the job (`routing.reason`) and shown on `/network`.

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
| `COMMUNITY` | as `AUTO`, with one ordering rule: an eligible `NATIVE_NETWORK` row serving a real (non-mock) model is moved to the front; the score orders everything behind it | | | | |

Ties break on higher `confidence`. `COMMUNITY` is the default for a `PUBLIC` request in `AUTO` on a plan that runs on the community first (`BRAIN_COMMUNITY_FIRST`, default: the free plan); the decision and the receipt record `COMMUNITY`, not `AUTO`, when that happened. The privacy gate is unchanged, so a `STANDARD` or `PRIVATE` request never reaches a node this way, and a request a node cannot take (tools, no node online) falls through to the `AUTO` ranking with that reason on the row. The ranked list, weights, per-row penalties and the plain-language reason are stored on the `RouteDecision` and shown on the receipt and in "HOW BRAIN RAN THIS".

## Step 5: execute with fallback

The selected provider runs the step. If it fails before producing output, the next eligible row is tried, and every attempt is recorded on the decision. For streaming chat, fallback is possible only before the first byte; after that the stream belongs to the client and a failure is reported as an error event with the `brain` summary attached. If no row is eligible, the API returns `503 no_provider_available` with every target's exclusion reason. BRAIN never answers from a target it did not select, and never invents an answer.

## Compound plans

`compoundPlan(steps, dependencies)` validates a DAG; `executePlan()` runs it in topological waves, injecting each step's result into dependants (`withContext`) and skipping dependants of a failed step. `planTotalCost()` is UNKNOWN if any step's cost is UNKNOWN. Nothing in production emits a compound plan yet; the primitives are tested so the first multi-step workload does not require a redesign.

## Learning

`observeRoute()` records mode, selected target, estimate and outcome. It is a recorder only. Weight adaptation will be considered once there are enough REAL observations to evaluate against; until then the weights above are static and published.

## What the router does not do

- Guess a price, a latency or a quality tier.
- Prefer a target for business reasons inside a mode; only the published weights and the request's constraints apply. (`COMMUNITY` is a mode with a published ordering rule, chosen by the request or by the plan, and it is recorded as such.)
- Claim that an upstream model response was verified. Only browser-network work is `VERIFIED`.
- Compare BRAIN's prices with other vendors.
