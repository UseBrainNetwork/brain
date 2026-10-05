# Phase 3

Shortest path from the Phase 2 prototype to (1) real distributed inference, (2) real external customers, (3) real payouts. Plus the runbooks for deploying and demoing what exists today. `NEXT_STEPS.md` holds the longer backlog; this file is the critical path.

## 0. What is true today

- One server process. Real browser nodes join, real `u32` matmul jobs are split, executed, spot-checked, reassigned on node loss, and settled into receipts.
- Routing picks between the browser network and two upstream providers using measured latency and configured prices. Upstream LLM answers are passed through and labeled unverified.
- The ledger exists and is isolated by source, but nothing is settled: no payment rail, no automatic creator-reward ingestion, payouts off.
- Without `DATABASE_URL` everything is in memory; without an HTTPS origin WebGPU is unavailable in browsers.

## 1. Deploy for a live demo (today)

The demo needs a single long-lived process (in-process event bus and SSE) and a secure origin (WebGPU). Vercel serverless does not satisfy the first; use one VM or a laptop plus a tunnel.

```bash
# on the host (Node 20+)
git clone <repo> brain && cd brain && npm ci
cp .env.example .env.local
# .env.local (minimum)
#   BRAIN_SERVER_SECRET=<openssl rand -hex 32>
#   BRAIN_ADMIN_TOKEN=<openssl rand -hex 24>
#   DATABASE_URL=postgres://...        # optional but recommended: psql $DATABASE_URL -f db/schema.sql
#   BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS=0.002   # optional; enables priced receipts + ledger
#   BRAIN_EXTERNAL_BASE_URL/_API_KEY/_MODEL      # optional; enables chat routing targets
npm run build && PORT=3100 npm start

# HTTPS origin (pick one)
cloudflared tunnel --url http://localhost:3100      # prints https://<random>.trycloudflare.com
# or: ngrok http 3100
# or: caddy reverse-proxy --from demo.yourdomain.com --to localhost:3100
```

Checks before the room fills: `GET /api/network/real` returns `realNodes: 0`; `/node` on a WebGPU browser shows a JOIN NETWORK button, not "NO WEBGPU ADAPTER"; `/network` answers "0 real nodes" (no SIM numbers appear on `/demo`, `/node`, `/network` or `/economics`).

Nothing secret is ever sent to the browser. Keep `.env.local` out of git (it already is).

## 2. Five-device demo script (today)

1. Projector: open `https://<origin>/demo`. It reads **0 REAL NODES ONLINE**. Leave it.
2. Devices 1–5 (Chrome / Edge 113+, Safari 26+, or Firefox 141+ on Windows; phones work if the browser has WebGPU): open `https://<origin>/node`, tap **JOIN NETWORK**. Each takes ~3 s (adapter → server-verified benchmark → join). The projector counts 1→5 and animates each node into the ring. Each node screen shows `NODE <id> · CONNECTED · WAITING FOR WORK…`.
3. Projector: press **RUN TEST JOB** (default medium, 4 units per node). Watch REQUEST → SPLITTING → units streaming to nodes → per-node COMPUTING → RETURNING → VERIFIED. Node screens show `JOB RECEIVED / WORK UNIT #… / COMPUTING…` then `VERIFIED ✓ +N COMPUTE UNITS`.
4. JOB COMPLETE panel: NODES USED, REAL WEBGPU YES (server-verified), WORK UNITS, VERIFIED x/y, TOTAL COMPUTE, LATENCY. Click through to `/receipt/r-<jobId>` to show the permanent record and the per-node timeline.
5. Failure demo: run a LARGE job, then close one device's tab while its units are computing. Its units turn LOST → REASSIGNED, the job still completes; the receipt shows `reassigned: 1`. The projector node count drops within ~12 s.
6. Routing demo: open `/auto`, pick a medium compute request, **Route & execute**. The three targets are estimated (upstreams show UNKNOWN cost when unconfigured), the browser network is selected, the job runs and a receipt is linked. With a chat request and an upstream configured, the same screen routes to the cheapest provider and the receipt says `unverified-provider-response`.
7. `/network` for the five questions; `/economics` for the ledger (NOT ENOUGH DATA unless a price is configured — say so out loud); `/node/<id>` for one device's reputation.

Hidden controls on `/demo` ("Demo controls"): SMALL / MEDIUM / LARGE, units per node, redundancy 1 / 2. They change the real job, never its timing.

If a device shows **NO WEBGPU ADAPTER**: that browser cannot contribute; the page says so and does not register. On iPhone use Safari 26+; on Android use Chrome with WebGPU enabled.

## 3. Known limitations

- **One process.** The event bus, rate limiter and challenge store are in-process; a second instance would split the network. Redis/NATS or Postgres LISTEN/NOTIFY is the fix.
- **Durability.** Production (Vercel) now runs on Supabase Postgres, so nodes, jobs, receipts and the ledger persist. A self-hosted demo without `DATABASE_URL` falls back to memory and loses everything on restart.
- **Verification strength.** Spot checks catch lazy nodes with probability \(1 - 0.75^{8} \approx 90\%\) per unit for a 25 % skipper; redundancy 2 is available but not default. There is no cryptographic attestation; `resultHash` is an integrity digest.
- **Workload.** Integer matmul only on the browser network. No model inference, embeddings or tokens are produced by contributors. Chat requests go to upstream providers and are not verified.
- **Money.** Accruals only. No payments, no invoices, no automatic creator-fee ingestion, payouts off. Prices are operator-set list prices, not market prices.
- **Identity.** Anonymous node ids; one wallet can own many nodes (the engine caps per account, but account linking requires a verified wallet).
- **Latency estimates** come from a handful of completed jobs on the same server and are UNKNOWN until there are any.
- **Browser support.** WebGPU requires a secure context and a recent browser; Vercel's serverless runtime cannot host the SSE/event-bus demo.

## 4. Critical path

### 4.1 Real distributed inference (first useful workload: embeddings)

Build order, each step verifiable with the existing receipt/verification machinery:

1. **f32 kernels with tolerance verification.** Add `matmul_f32`, `layernorm`, `softmax` to `webgpu/kernels` and a CPU reference in `network/workloads.ts`. Verification becomes "server recomputes `sampledRows` and accepts within ε" instead of exact u32 hashes. Receipt `verificationMethod: "spot-check-tolerance"`.
2. **Weight shards in the browser.** Content-addressed shards (OPFS/IndexedDB), announced in the heartbeat as `shards: [hash…]`; the scheduler prefers nodes already holding what a unit needs. Start with one small embedding model (e.g. 22–33 M params, 6 layers, 384 dims), fits every WebGPU device.
3. **`brain/embed` on the browser network.** A request becomes units of N texts each; each unit returns the embeddings plus a hash; the server recomputes a sampled subset on CPU. This is the first point where `BrowserNetworkExecutionProvider.supports` includes a model, `/capacity` can show `embeddings: LIMITED/AVAILABLE` from real outcomes, and `/v1/embeddings` can route `BROWSER_NETWORK`.
4. **Then layer sharding for a 0.5–1.5 B decoder**: pipeline stages per node, server-relayed activations first, WebRTC data channels second. Prefill in the browser network, decode on cloud fallback, is an acceptable intermediate reported honestly in `route`.

Do not attempt a 7 B+ model sharded across phones. The bandwidth per token kills it and it would have to be faked to look good.

### 4.2 Real external customers

1. **Prepaid credits + Stripe Checkout** (or USDC on Solana) that creates `CUSTOMER_PAYMENT … settlement: "settled"` events with the payment id as `transactionReference`. Requests debit a balance; `/v1/usage` shows it. This flips the "Is someone paying?" cell on `/network`.
2. **Customer console**: key management (already server-side), usage, receipts per request. Minimal UI; the API exists.
3. **Published list prices** only once an upstream cost is configured, so `protocolRevenue` is a real margin and not a guess. No comparison claims.
4. **SLA signal**: `/capacity` and the estimate `confidence` are already honest; expose them on the API (`x-brain-capacity`) so customers can decide before sending.

### 4.3 Real payouts

1. **Creator-reward ingestion**: implement `PumpFunAdapter.sync()` against the creator wallet's on-chain transfers (RPC `getSignaturesForAddress` → parse claims), writing settled `CREATOR_REWARD_RECEIVED` events with signatures. Until then the `manual` adapter is the only honest path.
2. **Account linking**: verified wallet per node (exists) becomes the `accountId` the reward engine caps on; require it for payout eligibility.
3. **Epoch close → claims**: `finalizeEpoch` with `fromTreasury: true`, publish the epoch hash, then the existing claim flow (`BRAIN_PAYOUTS_ENABLED=true`, funded payout wallet, Postgres mandatory). Pay from a hot wallet funded per epoch, never from the treasury key.
4. **Signed receipts**: sign `resultHash` + totals with a server key, expose the public key, set `attestation.kind: "server-signature"`. Anchoring a daily Merkle root on Solana is a one-day follow-up and should only be claimed once it is running.

### 4.4 Infrastructure that all three need

- Postgres everywhere (already supported) and a shared event bus (Redis pub/sub) so more than one instance can run.
- Redundant execution by default for priced work (`redundancy: 2`), reputation-weighted.
- Per-wallet / per-IP-hash node limits and anomaly detection before money flows.

## 5. Order of work

1. Postgres + Redis bus (unblocks everything, one week).
2. Prepaid credits with settled payments (first real revenue line, one week).
3. Tolerance-verified f32 kernels + embedding shards + `brain/embed` on the browser network (first real inference, three to four weeks).
4. Creator-fee ingestion, account linking, epoch payouts, signed receipts (two weeks).
5. Small-decoder pipeline sharding (after 1–4; research-grade).

Every step keeps the REAL/SIMULATED split and the "UNKNOWN beats estimated" rule. The dashboards already know how to say NOT ENOUGH DATA; let them.
