# Security model and threat model

Reporting a vulnerability: see [SECURITY.md](../SECURITY.md) at the repository root.

## Assumptions

1. **Node operators are adversarial.** Anyone can run the agent. A node may lie about its GPU, VRAM, utilisation, speed, uptime, token counts, or return a wrong answer. Nothing a node reports is used as a fact about hardware; it is stored under `reported` and labelled `REPORTED` wherever it is shown.
2. **Developers are adversarial.** A request may try to run code on a node, exhaust it, exfiltrate another tenant's prompt, or spend credits it does not have.
3. **The network is hostile.** Requests may be replayed, forged, or captured.
4. **The coordinator is the only trusted party**, and it must still fail safe: a coordinator bug may lose availability, never award compute that did not happen.

## Controls that exist today (LIVE)

### Node identity and authentication

- Ed25519 key pair generated on the node (`node/src/identity.ts`), seed stored with mode 0600, never sent anywhere. Node id is a hash of the public key, so an id cannot be chosen.
- Every node → coordinator request is signed over `brain-node-v1\nMETHOD\npath\ntimestamp\nsha256(body)`. The coordinator verifies against the key bound to the id (trust on first use; a second key for a known id is refused with `node_id_taken`), rejects timestamps outside 60 s, and keeps a per-instance replay cache (`services/coordinator/auth.ts`). Tests cover tampering with method, path, timestamp and body.
- Nodes are outbound-only. The agent opens no listening socket; the vLLM container binds loopback only.

### Workload isolation

- The allowlist (`node/models.ts`) is the only source of what a node may run: image tag, model repository and launch arguments are fixed in code. Neither a developer's request nor a node operator's env can add to it at runtime.
- Mock nodes may only advertise `brain/mock`; real nodes may never advertise it. The registry enforces this on register and heartbeat, so mock output cannot be sold as a real model and a real request cannot land on a fake.
- vLLM runs in Docker with `--cap-drop ALL --security-opt no-new-privileges`, a dedicated cache volume and a pinned image. Inference requests are structured chat turns; there is no code, shell, or file path in the protocol.

### Request validation and limits

- OpenAI-shaped requests are validated (`api/gateway.ts`); role, size and tool schema limits are enforced; image parts are rejected rather than dropped.
- Per-IP fixed-window rate limits on every public route; node routes have their own limits (`nodeRoute(handler, limit)`); signed node bodies are capped (64 KiB register, smaller elsewhere); job output is capped at 200 000 characters.
- Job timeouts: start within 20 s, progress within 60 s, hard deadline per job. Expired jobs fail or re-queue; a node that times out is recorded as such.

### Trust boundaries on data

- **Measured vs reported.** Routing uses only coordinator-measured speed, first-byte latency, completion rate and uptime. The reported GPU name and VRAM act only as *exclusion* filters (a node that reports less VRAM than a model needs is never selected); they never raise a score.
- **Benchmarks** are coordinator-issued, pinned jobs timed on the coordinator's clock. Compute class derives from that timing; the GPU name is display-only.
- **Reliability score** is computed server-side from recorded outcomes and belongs to the node id.
- **Verification label.** Node work is marked `node-reported`, `verified: false` on receipts because the coordinator does not re-execute every request. The checks it does run (response hash, stream consistency, token plausibility, wall-time) are described on the receipt. Sampled redundant execution and canaries (`services/coordinator/verify.ts`) run as unpaid coordinator probes and move the node's reliability score; they are shown on the job, never used to relabel a receipt as verified. Browser WebGPU work keeps its bit-exact spot-check verification.
- **Mock nodes** are refused by a production coordinator unless the operator sets `BRAIN_ALLOW_MOCK_NODES=1`, so the public registry cannot be filled with labelled-but-fake nodes.
- **Zero verified compute, zero reward.** Receipts are issued only for `COMPLETED` jobs with a matching response hash. Benchmark jobs issue no receipt. The accounting ledger accrues only from receipts, and `settled` is 0 until a payout actually runs.

### Secrets and logs

- All secrets are server-side env (`BRAIN_SERVER_SECRET`, `BRAIN_COORDINATOR_SIGNING_SEED`, API keys, database URL). Nothing with a secret is prefixed `NEXT_PUBLIC_`.
- API keys and session tokens are stored as sha256. The coordinator signing seed is never logged or returned; only the public key is served at `/api/coordinator/signer`.
- Public endpoints and the SSE stream carry no prompts, outputs, IPs, wallets or public keys: `publicInferenceJob` strips `request`, `output`, `requesterId`; `publicNativeNode` strips the key and the IP hash; `njob.progress` deltas are blanked before leaving the process.
- Logs print node ids, job ids, states and sizes. They do not print bodies, keys or IPs.

### Receipt integrity

- Canonical serialisation (sorted keys, fixed field set) → sha256 → ed25519 signature by the coordinator key. Anyone can verify a receipt against `/api/coordinator/signer` without talking to the database.

## Residual risks and planned controls (PLANNED)

| Risk | Today | Planned |
| --- | --- | --- |
| A node returns a plausible but wrong answer | Sampled redundant execution (5% of deterministic jobs re-run on a second node, similarity-compared, mismatches penalise both nodes) and scheduled canaries with checkable answers (two failures = DEGRADED). Receipts remain `node-reported` | Higher sample rates for new nodes; re-execution of disputed jobs on a third node to attribute blame |
| A node under-reports speed to avoid work or over-reports to attract it | Speed is measured by the coordinator; reports are ignored for routing | — |
| A node reports VRAM it does not have to receive large models | It will fail to load, be marked `DEGRADED` after 3 consecutive failures, and its reliability drops | Benchmark with a VRAM-pressure probe; attestation via NVML/DCGM when available |
| Replay across coordinator instances | Per-instance replay cache plus 60 s window | Shared replay cache in the store |
| Prompt exposure to node operators | Node models default to `privacy: public`; `standard`/`private` requests cannot be routed to nodes (`400 privacy_conflict`) | Confidential-compute nodes as a distinct trust tier |
| Sybil nodes | Reliability starts at 70 and work is paid only on completion; one benchmark per node; IP hash recorded | Stake-free per-node rate shaping by measured history; wallet verification for payouts |
| Coordinator key compromise | Key derived from `BRAIN_SERVER_SECRET` unless `BRAIN_COORDINATOR_SIGNING_SEED` set | Key rotation with published key history; anchoring receipt batch hashes on Solana |
| Denial of service through long polls | Work route capped at 20 s and 1200/min/IP; serverless `maxDuration` 30 | Persistent WebSocket transport behind the existing `Transport` interface |

## What this document does not claim

- It does not claim node output is verified. It is labelled, consistently, as node-reported.
- It does not claim hardware figures are measured. They are reported.
- It does not claim payouts have happened. The ledger's `settled` figure is the only statement about payment, and it is 0.
