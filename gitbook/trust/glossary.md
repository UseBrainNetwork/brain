# Glossary

**Allocated.** SOL assigned to wallets by settled epochs. Σ `distributedLamports` over live epochs.

**BRAIN AUTO.** The resource-class router: picks between browser network, GPU nodes, operator cloud and external models by hard filters then a weighted score.

**Brain Node.** A GPU node: the outbound-only agent running vLLM on a machine with an NVIDIA card.

**Brain Reliability Score.** 0 to 100 per GPU node, from recorded outcomes; 20 % of the routing score; belongs to the node id.

**Browser node.** A tab on `/earn` contributing WebGPU compute.

**Canary.** A job with a mechanically checkable answer, sent as an unpaid probe.

**Claim.** A signed message by which a wallet collects its allocated SOL from the payout wallet.

**Claimed.** SOL actually sent to contributors. The only figure that means "paid".

**Compute class.** `EDGE` < 12 tok/s ≤ `CONSUMER` < 40 ≤ `PRO` < 90 ≤ `DATACENTER`, from coordinator-timed decode speed.

**Coordinator.** The server: routes, times, verifies, signs, settles. The only trusted party.

**Creator fee.** SOL earned by the token's creator on each trade, accruing in the pump.fun vault.

**DEGRADED.** Node state: out of customer routing after consecutive failures or canary failures, until a canary passes.

**DEMO.** Label for a component that works end to end on a labelled mock.

**Distributed job.** A browser-network job split into work units across tabs.

**Epoch.** One clock-aligned hour. Settled at two minutes past.

**EST.** Badge for an estimate from the real formula with simulated inputs.

**LIVE.** Badge and label for something measured or verified by this server and deployed in production.

**Measured.** A value the coordinator established itself (speed, latency, uptime, outcomes). Used for routing and pay.

**Mock node.** A node that serves only `brain/mock` and says so. Refused in production by default.

**Network inference.** Qwen3 pipeline-sharded across browser tabs, verified by replica agreement, in `/chat` NETWORK mode.

**node-reported.** Verification label on GPU-node receipts: coordinator checked hash, stream, plausibility and clock; did not re-run the model.

**Owed.** Allocated minus claimed.

**Payout wallet.** `7TSAzUKLyCPb5AqzXUPMy4mTwVj4sdng2Gu2omSsaxVF`. Funds epochs and sends claims.

**PLANNED.** Label for an interface or stub that exists so the shape is visible and does nothing yet.

**Pool.** The fixed SOL per epoch, `BRAIN_EPOCH_POOL_SOL`, split by verified work.

**Protocol wallet.** `HZLev74M3ATV5jQJsoN8FcJAKx3RUefAobhcXr3egxwa`. Receives creator-fee claims.

**Receipt.** The signed or recorded statement of what ran, where, how long, how verified, and at what cost.

**Reported.** A value a node sent about itself. Stored separately, labelled, used only to exclude.

**Replica dispute.** A shadow re-run disagreed with the primary; the primary's work is re-recorded as lost and unpaid.

**Runway.** (Payout wallet balance − owed) ÷ pool, in epochs.

**Shadow re-run.** Sampled redundant execution: a deterministic job re-run on a second node and compared.

**SIM.** Badge for simulated data, shown only when the viewer turns it on.

**Spot-check.** Server recomputes secret rows of a browser work unit's output and compares.

**UNKNOWN.** What the site shows when a value has not been measured or configured. Never an estimate.

**Verified compute units.** The unit of pay: integer operations for browser work, `parameters × tokens ÷ 2²⁰` for inference, counted only when verified.

**Work unit.** One independent piece of a distributed job, assigned to one tab.

**WorkRecord.** The settlement-side record of a verified piece of work, from either tier.
