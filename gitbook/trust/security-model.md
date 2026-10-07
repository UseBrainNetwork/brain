# Security model

Summarised from [`docs/security.md`](https://github.com/UseBrainNetwork/brain/blob/main/docs/security.md). Report vulnerabilities as described in the repository's `SECURITY.md`.

## Assumptions

1. **Node operators are adversarial.** A node may lie about hardware, speed, uptime, token counts, or return a wrong answer. Nothing a node reports is used as a fact.
2. **Developers are adversarial.** A request may try to run code on a node, exhaust it, read another tenant's prompt, or spend credits it does not have.
3. **The network is hostile.** Requests may be replayed, forged or captured.
4. **The coordinator is the only trusted party**, and it must still fail safe: a bug may cost availability, never award compute that did not happen.

## Controls that exist

### Identity

* GPU nodes: ed25519 key pair generated locally, seed at mode 0600, never transmitted. Node id is a hash of the public key. Every request signed over method, path, timestamp and body hash; 60-second window; replay cache; a second key for a known id is refused.
* Browser nodes: anonymous persistent id, session token stored as sha256, IP stored as a hash.
* Wallets: a server nonce signed by the wallet, verified with ed25519.
* API keys: random, shown once, stored as sha256.

### Isolation

* The model allowlist is in code. Image tag, repository and launch arguments are fixed. No request and no operator environment can add to it at runtime.
* vLLM runs with `--cap-drop ALL`, `no-new-privileges`, loopback-only port, pinned image, dedicated cache volume.
* Inference requests are structured chat turns. There is no code, shell or file path in the protocol.
* Mock nodes may only advertise `brain/mock`; real nodes may never. Enforced on register and heartbeat.

### Limits

* Per-IP fixed-window rate limits on every public route. Node routes have their own.
* Signed node bodies capped (64 KiB register, smaller elsewhere). Job output capped at 200,000 characters.
* Job timeouts: start within 20 s, progress within 60 s, hard deadline per job. Cold vLLM start allowance 240 s.
* Work long-poll capped at 20 s and 1,200 per minute per IP.

### Trust boundaries on data

* Reported versus measured, stored separately, labelled everywhere. Routing uses only measured values. Reported VRAM can exclude a node from a model and never promote it.
* Benchmarks are coordinator-issued and coordinator-timed. Compute class follows from the timing.
* Reliability belongs to the node id and is computed from recorded outcomes.
* Receipts for node work say `node-reported`, `verified: false`. Probes move reliability and never relabel a receipt.
* Zero verified compute, zero reward, enforced in the formula and in settlement.

### Secrets and logs

* Every secret is server-side. Nothing with a secret is prefixed `NEXT_PUBLIC_`.
* The coordinator signing seed is never logged or returned; only the public key is served.
* Public endpoints and the SSE stream carry no prompts, outputs, IPs, wallets or public keys.
* Logs print node ids, job ids, states and sizes. Not bodies, keys or IPs.

### Receipt integrity

Canonical serialisation, sha256, ed25519 by the coordinator key. Verifiable offline against the published key.

## Residual risks

| Risk | Today | Planned |
| --- | --- | --- |
| A node returns a plausible wrong answer | 5 % shadow re-runs, both nodes penalised on mismatch; hourly canaries; two failures = `DEGRADED`. Receipts stay `node-reported` | Adaptive sample rate by tenure; third-node re-run to attribute blame |
| A node over-reports VRAM to get large models | It fails to load, degrades after 3 consecutive failures, reliability drops | VRAM-pressure probe; NVML/DCGM attestation |
| Replay across coordinator instances | Per-instance cache plus 60 s window | Shared replay cache in the store |
| Prompt exposure to operators | `STANDARD` and `PRIVATE` cannot reach nodes | Confidential-compute tier |
| Sybil nodes | Pay only on verified completion; one benchmark per node; IP hash recorded; reliability starts at 70 | Rate shaping by measured history |
| Coordinator key compromise | Key from `BRAIN_SERVER_SECRET` or a dedicated seed | Rotation with published key history; on-chain anchoring |
| Database as a single point of failure | Breaker, stale bodies, pooler-rejection retry | Replication across regions |

## What this model does not claim

That node output is verified. That hardware figures are measured. That payouts beyond the on-chain record have happened. That there is more than one coordinator today.
