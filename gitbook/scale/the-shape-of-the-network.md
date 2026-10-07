# The shape of the network

Before talking about what the network becomes, it helps to be precise about what it is. A crowd of consumer devices is not a datacenter with more racks. It has a different shape, and the shape decides what it is good for.

## Memory in slices

On 7 October 2026 at 19:10 UTC, the 227 browser tabs with a heartbeat in the previous two minutes advertised **204 GB** of schedulable GPU memory between them, about **0.9 GB each**. That figure is what the adapters reported, halved by BRAIN's own safety margin, so it is conservative. It is also the single most important number for understanding the network.

204 GB sounds like a lot of memory. It is not one pool. It is 227 pools of roughly 1 GB with no fast link between them, each behind a home internet connection, each able to vanish when someone closes a tab.

```
Datacenter node:   ████████████████████████████████████████████████████████████████  80 GB, one address space, 3 TB/s
Crowd, same total: █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ █ … 80 × 1 GB, 80 addresses, home broadband
```

That shape is bad for one thing and good for several.

## What the shape cannot do

Hold one large model. A 70-billion-parameter model at 4-bit needs on the order of 40 GB in one place, or split across machines connected by something much faster than the public internet. The crowd cannot serve it, and BRAIN does not pretend to. Frontier-scale training is further still out of reach. See [Honest limits](honest-limits.md).

## What the shape is good for

**Embarrassingly parallel work.** Anything that splits into independent pieces with small inputs and small outputs: the integer matrix multiplications that are BRAIN's verification workload, batch embeddings, scoring, filtering, evaluation sweeps, rendering of independent frames. Each tab takes a unit, computes, returns a hash. The crowd's total throughput scales with its size and its unreliability is handled by reassigning units.

**Many copies of small models.** A 1 to 2 billion parameter model at 4-bit fits in roughly 1 GB. The crowd can run hundreds of independent instances of it, which is exactly the shape of agentic workloads: many cheap calls, each small, in parallel.

**Pipeline stages of medium models.** BRAIN already does this: Qwen3 1.7B in four stages, 4B in six, each stage one tab, hidden states relayed between them, every stage verified by a twin. It is slower than a single GPU and limited by the slowest tab, and it works.

**Presence.** A device that is online, benchmarked and heartbeating is capacity that can be counted and sold even before it is used. The crowd's size is itself a product.

## The dedicated tier changes the shape

GPU nodes are the other half. An RTX 4060 has 8 GB in one address space with 270 GB/s of bandwidth, which is a different animal from a browser tab. On the live network the 4060 serves Qwen 2.5 1.5B at 64.8 tokens per second, coordinator-timed, as a single machine with no relay hop. A 12 GB or 24 GB consumer card can hold 7B to 14B models at 4-bit on its own.

So the network has two shapes at once, and routing is the act of matching a request to the right one:

| Request | Goes to |
| --- | --- |
| Verifiable parallel compute | Browser crowd |
| Small-model inference, many parallel calls | Browser crowd (as pipeline stages) or dedicated nodes, by score |
| 7B to 14B models, low latency | Dedicated nodes |
| Anything the request's privacy level forbids on untrusted hardware | Operator cloud or upstream, never the crowd |
| Anything nobody can serve | `503` with reasons |

## Why this is the right starting shape

Because it is the shape of the hardware that already exists. There are far more 8 GB consumer cards and 1 GB browser buffers in the world than 80 GB datacenter accelerators, and they are already paid for, already plugged in and already idle. A network that fits the shape of what exists can grow by people showing up; a network that needs the other shape can only grow by someone buying it.

The next page is about what changes as more people show up.
