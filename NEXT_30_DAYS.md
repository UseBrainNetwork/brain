# Next 30 days

Validation before interface. The product can now take a real request, route it, answer it, price it, receipt it and credit it. The next month should prove those loops hold up under real users and real contributors, and make the unverifiable parts verifiable. Nothing below adds a new page unless a measurement demands one.

## Week 1: harden what shipped

- [ ] Set `BRAIN_SERVER_SECRET` on Vercel so account cookies survive across instances. Rotate the OpenRouter key (it was pasted into a chat once).
- [ ] Multi-instance event bus (Postgres `LISTEN/NOTIFY` or a hosted pub/sub) so `/network` and the chat `brain` events are consistent across Vercel instances. Today each instance has its own in-process bus.
- [ ] Persist `observeRoute()` observations to the store and expose a read-only `/api/routing/observations` so routing claims can be audited.
- [ ] Load-test `/api/chat` streaming at the Free-plan rate limit from 50 concurrent accounts; confirm credits are consumed exactly once per receipt and 402 fires at zero.
- [ ] Repeat the real-device demo at `/earn` on at least three physical machines (Mac, Windows/Chrome, Android/Chrome) and record what WebGPU reports unavailable.

## Week 2: make the real parts undeniable

- [ ] Publish `/api/stats` fields for chat: real requests served, real receipts issued, median latency, upstream cost total, all REAL only. Put the same numbers in the homepage strip (already reads `/api/stats`).
- [ ] Receipt signing: Ed25519 signature over the receipt body with a published server key; `attestation.kind: "server-signature"`. Still not proof of execution, and the receipt page must keep saying so.
- [ ] Stable reliability estimates: switch upstream reliability from "recent success rate" to a windowed EWMA with a minimum sample count before leaving `LIMITED`.
- [ ] Browser-network chat-adjacent workload with a real customer use: embedding-shaped matvec is already verified; price it and expose it as `compute.matvec` so the browser pool can appear in a priced receipt a developer actually requested.

## Week 3: close the contributor ↔ consumer loop with money that moved

- [ ] Manual treasury: record at least one `settled` REAL event with a transaction reference so `/economics` shows a non-accrued line.
- [ ] Compute offsets: verify end-to-end on production that a wallet attached to an account sees its node's REAL earnings as `COMPUTE_OFFSET` lines and that `NET` goes positive from verified work alone.
- [ ] Decide payments: either connect a processor for Pro/Max (then `paymentsConnected()` flips and PLACEHOLDER labels drop) or keep them placeholders for another month. Do not fake the flip.
- [ ] Epoch v2 on production data: finalize one epoch from real jobs, publish `/epoch/[id]`, and confirm zero-compute accounts allocate zero.

## Week 4: decide the next workload from data

- [ ] Review routing observations: how often each mode selected each target, estimate error on cost and latency, fallback rate. Publish the table in `ROUTING.md`.
- [ ] If the browser pool has shown ≥ 10 online nodes for a sustained week, scope the first compound plan (e.g. retrieval-shaped matvec on the pool → chat on an upstream) using the existing `compoundPlan` primitives. Otherwise, do not.
- [ ] `NATIVE_NETWORK`: write the protocol note only. No client until the browser pool's economics are measured.

## Explicitly not in the next 30 days

Token emissions, staking, governance, NFTs, licenses, quests, points, a model marketplace, auctions, price predictions, "cheaper than X" claims, our own foundation model, distributed LLM inference on the browser pool, a redesign of the site.

## How we will know

| Claim | Measurement that would make it true |
| --- | --- |
| "BRAIN AUTO picks the right route" | Routing observation table shows estimate error and fallback rate; weights unchanged or changed with a written reason |
| "Your computer can power BRAIN" | ≥ 1 production receipt where a customer-requested job ran on a contributor's browser and `COMPUTE_OFFSET` reduced that contributor's usage |
| "Every answer has a receipt" | 100 % of chat requests in the window have a receipt id; none have `source: SIMULATED` |
| "Pay for intelligence, not for a model" | A Pro or Max plan that can actually be purchased, or the PLACEHOLDER label still on |
