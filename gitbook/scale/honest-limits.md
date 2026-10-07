# Honest limits

The things a crowd of consumer hardware cannot do, and will not be able to do by growing.

## One large model

Memory in the crowd comes in slices of roughly 1 GB (browser) to 8 to 24 GB (consumer cards). A model needs its weights in one address space, or split across machines with an interconnect measured in hundreds of gigabytes per second. Home broadband is measured in tens of megabytes per second. So:

| Model size (4-bit) | Approximate weights | Where it can run on BRAIN |
| --- | --- | --- |
| 0.6B to 2B | 0.4 to 1.2 GB | A single tab, or a dedicated node |
| 4B | ≈ 2.5 GB | Pipeline-sharded across tabs, or a dedicated node |
| 7B to 14B | 4 to 9 GB | Dedicated nodes with 8 to 16 GB |
| 30B to 70B | 18 to 40 GB | Dedicated nodes with 24 GB and up, or not at all |
| Frontier scale | hundreds of GB | Not on this network |

Sizes are standard arithmetic on parameter counts and are approximate. BRAIN does not display VRAM or TFLOPS figures for any node; the allowlist of models each node class may serve is in `node/models.ts` and is enforced in code.

## Training

No. Training needs the whole model and its gradients in fast-interconnected memory for days. The crowd does not have the shape for it and BRAIN does not try. Fine-tuning small adapters is theoretically parallel enough; it is not built and not planned.

## Latency floors

A pipeline-sharded model's step time is the slowest stage plus the relay hop, repeated per token. On the live network, Qwen3 1.7B across tabs produces tokens at a rate the receipt reports honestly, and it is slower than a single consumer GPU. Dedicated nodes avoid the relay but sit behind residential connections; the first-byte latencies the coordinator measured on the first nodes ranged from about a second to tens of seconds on a cold start. The router's latency term and the compute classes exist so that buyers who care about latency get the nodes that have it.

## Privacy

Node operators can read prompts that run on their machine. BRAIN handles this by rule, not by promise: plaintext requests at `STANDARD` or `PRIVATE` cannot be routed to the crowd. The route a request may take is decided before scoring and is visible on the trace. A confidential-compute tier is **PLANNED** and until it exists the crowd is `public` only.

## Verification of language-model output

Not bit-exact, and never will be across heterogeneous GPUs. The coordinator measures what it can, samples re-execution, keeps a reliability memory per node, and labels the receipt `node-reported`. That is the honest ceiling for this class of work without attestation, and attestation is **PLANNED**.

## Availability

A tab closes. A laptop sleeps. A home connection drops. The network's answer is reassignment, redundancy and routing by measured uptime, and its availability is a statistical property of the crowd, not a contract. Dedicated nodes are more stable but still residential. Nobody should put a pacemaker on this.

## The operator

Today there is one coordinator, run by one team, with one database. Receipts are signed by one key. The design has places for more than one of each of those, and the roadmap says so, but the honest description of BRAIN in October 2026 is a centrally coordinated network of decentralised hardware. The hardware is the part nobody owns; the coordination is not there yet.

## What is not a limit

Proof that it works. Several hundred strangers' devices doing verified work and getting paid for it on-chain, with every rule published, is already more than most of this category has ever shipped. The limits above are the reason the next steps are what they are, not a reason to doubt the step that has been taken.
