# Verification

The central engineering problem of a crowd-sourced GPU network is not scheduling. It is that every participant may be lying. BRAIN's answer is to verify what can be verified exactly, measure what can be measured directly, sample what can only be sampled, and label the result honestly on every receipt.

## Browser work: exact

Browser jobs are integer kernels (`matmul_u32`, embedding-shaped matvec, canaries) chosen because they are deterministic across every GPU. The server knows part of the answer before the job leaves.

| Check | How |
| --- | --- |
| Challenge on join | The server issues a secret-seeded challenge; the tab runs a WGSL kernel; the server recomputes secret blocks and scores on its own clock. The client's timing is ignored. |
| Spot-check | Each work unit's output includes rows the server can recompute from the secret seed. A mismatch fails the unit. |
| Canary | Full-answer jobs with a known result, mixed into the stream. |
| Plausibility | A unit that returns faster than any GPU could compute it is rejected. |
| Redundancy | Jobs may run each unit on two nodes and compare. |
| Reassignment | A unit whose node disappears (heartbeat timeout, orphaned unit) is reassigned; the job fails with a reason if it cannot finish. |

Receipts for this work say `verificationMethod: "spot-check"` or `"canary"` and `verified: true`. The `resultHash` is a sha256 over the ordered verified outputs: an integrity digest anyone can recompute, labelled as such, and **not** a cryptographic proof of execution.

## Network inference: agreement

In `/chat` NETWORK mode a Qwen3 model is split by layers across tabs. Every stage of every decoding step runs on two nodes when two hold that stage, and the outputs must agree within 2×10⁻³ relative RMS (for the final stage, at least 48 of the top-64 logit ids must match). Only fully checked, agreeing nodes get verified units; a stage that ran without a replica is recorded as `no-replica` and earns nothing. The kernels themselves were checked against a CPU reference to within 6×10⁻⁴ relative RMS.

## GPU-node inference: measured, sampled, labelled

Language-model output is not bit-identical across GPUs, so the exact method does not apply. The coordinator does four direct checks on every job:

1. **Hash.** The `responseHash` the node sent matches the text the coordinator received.
2. **Stream consistency.** The concatenated streamed deltas equal the final text.
3. **Token plausibility.** The reported token count is plausible for the output length; node-reported tokens are clipped to the streamed text before anything is paid.
4. **Wall time.** Measured on the coordinator's clock, not the node's.

Then two kinds of coordinator-initiated probe, which feed the node's reliability score:

* **Sampled redundant execution.** 5 % of deterministic (temperature 0) customer jobs are re-run on a different node after completion. Outputs are compared with a text-similarity heuristic (character 4-gram Jaccard blended with length ratio, threshold 0.8). A mismatch is recorded against **both** nodes, because the coordinator cannot tell which one lied. The primary job's work is re-recorded as `replica-dispute`: unpaid, not counted as a failed check. A **match** pays the shadow node too: it ran the same real prompt on the same model and its answer was checked against another machine, which is a stricter test than the primary passed. Its work record is labelled `native-verify`.
* **Canaries.** Fixed prompts with mechanically checkable answers, sent to every real node hourly, every 25 jobs, and 5 minutes after a failure. Two consecutive failures mark the node `DEGRADED` (out of customer routing) until a canary passes.

Receipts for this work say `verificationMethod: "node-reported"` and `verified: false`, because the coordinator did not re-run the model. The probe results are on the job and in the API's `brain.node.verification`, and they move the reliability score. They never relabel a receipt as verified.

{% hint style="info" %}
Why not re-run every request? Because it would double the cost of every answer and still not catch a node that lies consistently in a way another node would reproduce. Sampling plus a reputation that remembers is the standard answer to this problem, and the sample rate (`BRAIN_VERIFY_SAMPLE_RATE`) can be raised for new or suspect nodes. Full re-execution of disputed jobs on a third node, to attribute blame, is **PLANNED**.
{% endhint %}

## Reliability: the memory

Every node has a Brain Reliability Score from 0 to 100. It starts at 70 and moves with completion rate, timeouts and uptime, minus up to 20 points for the redundant-execution mismatch rate and up to 30 for the canary failure rate. It belongs to the node id, not to a wallet, so it cannot be transferred or reset by switching wallets. It is 20 % of the routing score and appears on `/network` and `/provider`.

## Benchmark: the entry exam

New GPU nodes receive a pinned, fixed-prompt job and are timed by the coordinator. Decode tokens per second becomes the benchmark score and the compute class:

| Class | Coordinator-timed decode speed |
| --- | --- |
| `EDGE` | under 12 tok/s |
| `CONSUMER` | 12 to 40 |
| `PRO` | 40 to 90 |
| `DATACENTER` | 90 and above |

The GPU name plays no part in this. An RTX 3050 laptop measured at 24 tok/s is `CONSUMER`; an RTX 4060 at 64.8 tok/s is `PRO`. Benchmark jobs issue no receipt and earn nothing.

## Summary table

| Work | Verification | Receipt label |
| --- | --- | --- |
| Browser `matmul_u32`, canaries | Server-seeded challenges, secret spot-checks, bit-exact | `spot-check` / `canary`, `verified: true` |
| Network inference stages | Replica agreement within tolerance | verified units only for agreeing nodes |
| GPU-node inference | Hash, stream, plausibility, clock; 5 % shadow re-runs; canaries | `node-reported`, `verified: false` |
| Upstream providers | None beyond transport | `unverified-provider-response`, `verified: false` |
