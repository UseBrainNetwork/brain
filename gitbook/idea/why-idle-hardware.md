# Why idle hardware

Three facts, none of them controversial.

**Consumer GPUs outnumber datacenter GPUs by a wide margin.** Every gaming PC, every Apple Silicon laptop, every workstation has a GPU capable of running integer kernels and small language models. Most of those GPUs do nothing for 20 or more hours a day.

**Inference demand is growing faster than datacenter supply.** New capacity takes years to build, needs grid power that does not exist yet, and is pre-sold to a few buyers. The result is queues, quotas and prices set by scarcity.

**The small-model tier is where most of the volume is.** Classification, extraction, embeddings, routing, drafting, evaluation, agents calling tools in loops. These do not need a frontier model. They need a 1B to 8B parameter model served cheaply and close to the user, and that is exactly what a consumer GPU can run.

BRAIN exists in the gap between those three facts.

## What a browser tab can and cannot do

A browser exposes a GPU through WebGPU with limits. On a typical machine the adapter allows a buffer of 256 MB to 4 GB; BRAIN schedules against half of that and records the figure as `advertisedMemoryGb`. It cannot see VRAM and never pretends to. What that slice is good for:

* Embarrassingly parallel work: the integer matrix multiplications that are BRAIN's verification workload, split into 64 units across dozens of tabs.
* One pipeline stage of a small language model. In NETWORK mode a tab downloads only the tensors for its stage of Qwen3 (0.6B to 4B, 4-bit or 8-bit) and passes hidden states to the next tab.
* Being present. A tab heartbeats, benchmarks, and keeps the network's capacity count honest.

What it cannot do is hold a 70B model or act as a low-latency server for someone else's production traffic. That is what the second kind of node is for.

## What a dedicated GPU node can do

A machine with an NVIDIA card and Docker runs the Brain Node agent. It serves allowlisted open-weight models through vLLM, is benchmarked by the coordinator on join, and is routed customer requests when it is online, has the model loaded, and has a free slot. The first ones on the network were an RTX 3050 laptop (24 tok/s on Qwen 2.5 1.5B, coordinator-timed), an RTX 3060 (35.7 tok/s), and an RTX 4060 (64.8 tok/s).

## Why not just build a datacenter

Because then BRAIN would be another provider, with the same capital cost, the same queue, and the same incentive to own the hardware. The point is that the hardware already exists and already belongs to people. The coordinator's job is to make it trustworthy enough to sell, which is a verification problem, not a procurement problem. The rest of this book is mostly about that problem.
