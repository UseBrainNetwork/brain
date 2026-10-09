# Network inference

The most ambitious thing BRAIN does today: run a language model across browser tabs, with no single tab holding the whole model, and verify every step by agreement between two tabs. It is live in NETWORK mode on [/chat](https://brainnetwork.app/chat), it is free, and it reports its real token rate.

## The model

Qwen3 (Apache-2.0) in GGUF:

| Model | Quantisation | Stages | Weights per tab | When |
| --- | --- | --- | --- | --- |
| 1.7B · single tab | Q4_0 | 1 | 1.14 GB | Tabs whose adapter can hold the whole model |
| 1.7B | Q4_0 | 4 | 0.3–0.4 GB | Default pipeline |
| 0.6B · single tab | Q8_0 | 1 | 0.64 GB | Tabs that can hold the whole small model |
| 4B | Q4_0 | 6 | 0.45–0.53 GB | Once enough nodes hold stages |
| 0.6B | Q8_0 | 3 | 0.25–0.3 GB | Small pipeline |

## Single tab or pipeline

The single-tab entries are the same weights as the pipeline entries with one stage holding every layer, the embedding and the head. A lap is one hop instead of three to six, so decode speed is bounded by one tab's GPU rather than the slowest of several plus the relay hops between them. Two such tabs serve a whole model.

A tab is only assigned a single-tab stage when half its adapter buffer limit (the same `advertisedMemoryGb` rule used everywhere on the network) covers the model's weight bytes. No browser exposes VRAM, so this is the only honest proxy; a stage that still does not fit fails at load and is reported as such. Capacity is filled single-tab first where tabs qualify, then the pipelines. When a chat does not name a model the gateway serves the largest one available and, at equal size, the single-tab variant.

Verification is identical: every lap goes to two tabs and their top-64 logits are compared. A single tab is never trusted alone; a lap served by one tab is recorded `no-replica` and earns nothing. The receipt and the chat panel say `whole model` instead of `stage n`, so the two topologies are never confused.

## How the model is split

By layers. The first stage holds the embedding, the last holds the final norm and the tied output head and returns the top-64 logits. The gateway holds no weights: it tokenises, samples, and streams.

A tab downloads only the tensors for its own stage, by HTTP range requests to the Hugging Face CDN, and caches them. It runs them with Q4_0 / Q8_0 WebGPU kernels that were checked against a CPU reference to within 6×10⁻⁴ relative RMS (the harness is at `/dev/llm-check`). Each tab keeps a per-session f16 KV cache.

## How hidden states move

Tab to tab, as f16, over a persistent WebSocket relay implemented as a Cloudflare Durable Object. The gateway issues HMAC tickets so only the tabs assigned to a session can join its relay room. Every lap around the pipeline carries the next token plus up to four prompt-lookup draft tokens, verified in one pass with KV rollback, so output is identical to plain decoding but fewer laps are needed.

```mermaid
flowchart LR
  G["Gateway<br/>tokenise · sample"] -->|token| S1["Stage 1<br/>embedding + layers 0–k<br/>tab A ∥ tab A′"]
  S1 -->|f16 hidden state| S2["Stage 2<br/>layers k+1–m<br/>tab B ∥ tab B′"]
  S2 -->|f16 hidden state| S3["Stage 3<br/>layers m+1–n + head<br/>tab C ∥ tab C′"]
  S3 -->|top-64 logits| G
```

## How it is verified

Every stage of every lap runs on two nodes when two hold that stage. Hidden states must agree within 2×10⁻³ relative RMS; for the final stage at least 48 of the top-64 logit ids must match. Only fully checked, agreeing nodes receive verified units (`kind: inference`, spec `llm_stage`). A stage that ran without a replica is recorded as `no-replica` and earns nothing. This is the browser-network equivalent of a bit-exact spot-check: the answer is trusted because two independent machines produced it.

## What the receipt shows

Model actually run, nodes per stage, hops, drafted tokens, first-token time, tokens per second as measured. No charge. The mode is never mixed with upstream answers; if the relay is not configured the mode reports no capacity rather than falling back to anything.

## Why this matters for scale

This is the proof that the browser tier is not only for integer kernels. A tab with a 1 GB slice can hold one stage of a small model, and enough tabs holding enough stages serve inference end to end without any machine that BRAIN owns. The limits are real: latency is bounded by the slowest tab and the relay hop, and the model must be small enough that a stage fits in a browser buffer. The [Scale](../scale/the-shape-of-the-network.md) section covers what those limits mean as the network grows.
