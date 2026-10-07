# Routing

Two routers, both deterministic, both explained on the receipt. Given the same registry and the same request, they always give the same answer, and the answer always comes with a reason.

## BRAIN AUTO: which kind of hardware

`engine/router.ts` chooses between four resource classes.

| Class | What it is | Trust tier |
| --- | --- | --- |
| `BROWSER_NETWORK` | Tabs running WebGPU kernels or Qwen3 stages | untrusted-distributed |
| `NATIVE_NETWORK` | Brain Nodes serving allowlisted models through vLLM | untrusted-distributed |
| `CLOUD_GPU` | vLLM the operator runs, when configured | operator |
| `EXTERNAL_MODEL` | An OpenAI-compatible upstream, when configured | third-party |

### Privacy is a filter, not a weight

```
privacyAllows   PUBLIC   → untrusted-distributed, operator, third-party
                STANDARD → operator, third-party
                PRIVATE  → operator
```

A chat request carries plaintext. If its privacy level does not allow the class, the class is excluded before any score is computed. Requests that name a Brain Node model default to `PUBLIC`, because those models only run on hardware BRAIN does not operate; asking for `PRIVATE` on such a model is a contradiction and returns `400 privacy_conflict` instead of routing somewhere else.

### Unknown is penalised, never guessed

Each class estimates cost, latency and reliability from its own measurements. A class with no price configured reports cost `null`; a class with no completed samples reports latency `null`. Both render as **UNKNOWN** on the trace and are penalised in the score. Nothing fills them in by assumption.

## Node router: which machine

Once `NATIVE_NETWORK` is chosen (or the request pins a node model), `services/router/score.ts` picks the node. It is a pure function with unit tests.

```
eligible  = state ONLINE, or BUSY with a free slot
          ∧ serves the model
          ∧ reported VRAM ≥ model requirement      (reported VRAM can only exclude, never promote)
          ∧ region match when required
          ∧ ask ≤ budget when a budget is set

NodeScore = 0.30 · capability
          + 0.25 · availability
          + 0.15 · latency
          + 0.20 · reputation
          + 0.10 · price
```

| Term | How it is computed | Source |
| --- | --- | --- |
| capability | 1.0 if the model is loaded, 0.6 if it must load first; × (0.5 + 0.5 · tok/s ÷ pool max) | coordinator-measured speed, then the join benchmark; 0.5 with a note if unmeasured |
| availability | (1 − active ÷ slots) · (1 − queue ÷ 4·slots) | coordinator's view of the node's slots |
| latency | heartbeat RTT: 1 − rtt/300 ms (×0.7) + 0.3 if at or under the pool median; +0.2 for region match | coordinator-measured |
| reputation | Brain Reliability Score ÷ 100 | coordinator-computed from outcomes |
| price | relative position of the node's ask among eligible nodes; 0.5 when no asks are set | operator-set `BRAIN_NODE_ASK_USD_PER_1M` |

Ties break on node id. A node that has not yet produced a coordinator-timed token (`benchmark.basis = unmeasured`) is rejected with `not yet benchmarked` and only the benchmark probe may target it.

### Rejections are sentences

When no node is eligible the error names each one and why:

```
0 of 3 nodes can serve qwen/qwen2.5-7b-instruct right now
  (N-3A4F…: VRAM 8 GB < 20 GB required; N-9B12…: offline; N-C7E0…: not yet benchmarked)
```

That sentence is what you get in the `503`, what appears on the job's history, and what shows on `/network`.

## Why the weights are published

Because a hidden router is an invitation to game it blind, and a published one is an invitation to game it in the open, where everyone can see what behaviour is being rewarded. The weights reward being fast on our clock, being free, being near, being reliable over time, and being cheap, in that order. A node operator who wants more traffic knows exactly what to improve.

The resource-class weights per mode are in [`ROUTING.md`](https://github.com/UseBrainNetwork/brain/blob/main/ROUTING.md) in the repository.
