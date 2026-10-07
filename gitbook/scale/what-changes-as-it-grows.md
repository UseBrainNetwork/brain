# What changes as it grows

There is a well-known pattern in distributed computing: a network pools idle hardware that individuals already own, verifies the work so buyers can trust strangers, and becomes a provider that no single company owns or can switch off. It has been done for 3D rendering. BRAIN is the same pattern applied to AI inference and parallel compute, and this page is a sober account of what happens at each order of magnitude, written while the network is at the first one.

{% hint style="info" %}
Nothing on this page is a projection of revenue, token price or earnings. It describes engineering consequences of size, what each stage makes technically possible, and what BRAIN would need to build. The payment rule does not change at any stage: a fixed pool, split by verified work, zero for zero.
{% endhint %}

## Stage 0: hundreds of devices (today)

**What it is.** Several hundred tabs online at a time, a few thousand that have ever joined, four dedicated GPUs. One coordinator region, one database.

**What it can serve.** Verified integer compute at a rate of a 64-unit job every few minutes. One pipeline-sharded small model in `/chat`. Single-digit tokens per second of Qwen 2.5 1.5B to API callers from the dedicated nodes.

**What it proves.** That the verification holds up against real strangers, that the hourly settlement pays real wallets (11.10 SOL so far), that a tab left open earns something, and that the control plane can be run on serverless functions for the cost of a hobby project.

**What breaks.** The database. Both outages so far were the single Postgres instance or its pooler, not the crowd. The crowd kept heartbeating through them.

## Stage 1: thousands

**What changes technically.**

* *Baseline work is no longer enough.* Today operator-scheduled matmul jobs keep the fleet exercised. At thousands of tabs that costs real SOL for work nobody asked for. The scheduler's per-hour cap and gap settings become the operator's main lever, and real demand has to replace baseline.
* *Aggregation becomes a batch job.* Settling an hour means aggregating every job in the window. It already runs under an advisory lock so one instance does it; at this scale it needs incremental per-wallet counters maintained as jobs complete rather than a scan at the top of the hour.
* *History must be pruned.* The jobs table grows by about a million rows a day at hundreds of nodes. Receipts and epoch allocations are the permanent record; raw job rows older than a few days are not.
* *Pipeline inference gets reliable.* With thousands of tabs there are always two holders of every Qwen3 stage, so the 4B tier is always available and every stage is always twinned. Latency is still bounded by the slowest tab and the relay hop.

**What it makes possible.** Continuous availability of small-model inference from the crowd rather than intermittent. Batch workloads (embed this corpus, score these candidates) with a clear completion time. Enough measured history per node that the reliability score means something.

**What does not change.** The pool. A thousand wallets split the same 0.15 SOL unless the operator raises it, and the operator can only raise it as far as fees fund. Growth in supply without growth in demand means less per wallet, and the site will show exactly that.

## Stage 2: tens of thousands

**What changes technically.**

* *The coordinator must be multi-region.* One database in one region is now a liability for latency and for availability. The store interface already exists; what it needs behind it is a replicated database and a shared replay cache for node authentication.
* *Verification sampling gets smarter.* A flat 5 % shadow rate across tens of thousands of jobs wastes compute on nodes with long clean histories and under-samples new ones. The sample rate becomes a function of reliability and tenure, and disputed jobs get a third run to attribute blame (both already **PLANNED**).
* *Dedicated nodes become the majority of inference.* The crowd handles parallel and small-model work; a few hundred 12 to 24 GB consumer cards can serve 7B to 14B models at latencies developers will actually accept.
* *Prompt privacy becomes a product tier.* Node models are `public` because operators can read prompts. A confidential-compute tier (attested enclaves) would let `STANDARD` requests reach the crowd. Attestation is **PLANNED**.

**What it makes possible.** An endpoint a developer can point production traffic at for small and medium open-weight models with a receipt on every answer. Regional routing. A meaningful spot market where node asks and the price term of the routing score start to matter.

## Stage 3: hundreds of thousands and up

At this size the network is a provider in the ordinary sense: someone can send it a million requests a day for an open-weight model and get them back with receipts, without anyone having bought a GPU for the purpose.

**What changes technically.** The coordinator itself becomes the thing to decentralise: multiple coordinators, receipts anchored on-chain so no single operator can rewrite history (**PLANNED**), a published key history for signer rotation. Verification moves from "the coordinator checks" to "anyone can check": the receipts and the anchoring are the public record, and the coordinator is one party that writes to it.

**What it makes possible.** Open-weight inference as a utility, priced by a published formula, verified by published rules, run on hardware that belongs to the people running it.

**What still does not change.** The crowd does not become a datacenter. Frontier models still need interconnected accelerators, and training does not happen here. The honest version of the destination is not "replace the datacenters" but "be the place everything that does not need a datacenter goes".

## What each stage costs the operator

The control plane is one database and serverless functions. At Stage 0 that is a small Postgres and a hosting plan. At Stage 1 the database moves up a size and history pruning becomes mandatory. At Stage 2 it is a replicated database in two or more regions. At no stage does the operator buy GPUs; that is the entire point. The infrastructure cost line on [/economics](https://brainnetwork.app/economics) will show what it actually costs when it is recorded; today it shows NOT ENOUGH DATA rather than a guess.

## How you will know which stage it is

[`/api/stats`](https://brainnetwork.app/api/stats) for devices online and joined. [`/api/coordinator/nodes`](https://brainnetwork.app/api/coordinator/nodes) for dedicated GPUs and their measured speeds. [/economics](https://brainnetwork.app/economics) for the pool, the runway and what has been paid. The stage is whatever those numbers say it is, not whatever this page says.
