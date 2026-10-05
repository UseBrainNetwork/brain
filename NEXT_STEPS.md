# Next steps

Ordered by what unblocks real revenue and real inference soonest. Each step is scoped to fit the abstractions that already exist.

## 1. Make the money real

1. **Creator-reward ingestion.** Watch the protocol's Pump.fun creator wallet: claimed fees become `CreatorRevenue` rows. Replace `services/mock` revenue in `services/data.ts` behind the same getters. Badge flips from SIM to LIVE.
2. **Epoch settlement (built).** `services/settlement.ts` settles closed epochs from verified job records via `POST /api/rewards/settle` (admin token) or Vercel Cron. Still to do: publish a signed per-epoch manifest so anyone can recompute it, and use time-weighted holdings instead of the balance at settlement.
3. **Payouts (built, off by default).** `/rewards` lets a wallet claim its live balance; `services/claims.ts` signs and sends SOL from the payout wallet. To go live: set `DATABASE_URL` (the in-memory ledger does not survive serverless restarts), fund a dedicated payout wallet with only what one epoch needs, set `BRAIN_EPOCH_POOL_SOL`, `BRAIN_TOKEN_MINT`, `SOLANA_RPC_URL`, `BRAIN_SERVER_SECRET`, then `BRAIN_PAYOUTS_ENABLED=true`. Consider a multisig-funded hot wallet topped up per epoch.
4. **Inference billing.** Issue API keys with usage metering in Postgres, prepaid credits, and per-model prices. Prices replace `$X.XX` only after measured cost benchmarks.

## 2. Harden verification before money flows

- **Wire redundant execution.** `compareRedundant` and `RedundancyPolicy` exist. The dispatcher should replicate low-reputation or high-value units to 2+ nodes and settle by majority.
- **Benchmark stability.** Scores vary run to run when the GPU is contended (we saw roughly 5.7k–27.7k on one M4 Max across concurrent headless runs). Take the median of 3 challenges, re-benchmark periodically, and weight rewards by verified throughput on real jobs rather than the entry benchmark.
- **Shared state.** The rate limiter, event bus, and challenge store are per-process. Move them to Redis or Postgres before running more than one instance.
- **Sybil and abuse controls.** Per-wallet and per-IP-hash node limits, a minimum account age before payout, and anomaly detection on verify/fail patterns.
- **Wallet holdings snapshots.** Use time-weighted balances per epoch so tokens can't be moved between wallets at settlement.

## 3. Real distributed inference (incremental)

Don't start with full distributed LLM inference. Build up through the existing interfaces:

1. **Tensor ops.** Extend `ComputeBackend` with real f16/f32 kernels (matmul, softmax, layernorm, RoPE, attention) and golden-output tests against a CPU reference with tolerance-based verification. `network/workloads.ts` stays the u32 verification path.
2. **Embeddings first.** Small, highly parallel, and stateless. Ship `brain/embed` on the browser pool: model shards cached in the browser, batch splitting in the router, and spot-check by recomputing a sample server-side. This is the first point where `BrowserNetworkProvider.supportedModels` becomes non-empty and the router can pick `BROWSER_NETWORK`.
3. **Shard caching.** Content-addressed weight shards in IndexedDB/OPFS, announced in the heartbeat. The router prefers nodes that already hold the needed shard.
4. **Layer sharding.** Pipeline-parallel decoding for small models (1–3B): contiguous layer ranges per node, activations passed between stages, expressed as a `compoundPlan` in `engine/plan.ts`.
5. **WebRTC data channels.** Node-to-node activation transfer with a signaling server, plus TURN fallback, to remove the server round trip per layer.
6. **Mixed execution.** The router splits one request between browser stages and a cloud fallback (e.g. browser prefill and cloud decode) and reports the split in `brain.routing`.

## 4. Product

- A persistent contributor identity across sessions (wallet-linked) and an earnings history.
- A contributor background mode (Service Worker plus visibility-aware throttling) with clear battery and thermal controls.
- Real model pools: pool membership derived from verified memory and score, replacing `modelPools` mock data.
- Public status page and explorer API.
- **Holder inference allowance** (announced as planned on /economics, parameters in `holderAccessPlan`). Snapshot linked-wallet holdings each epoch and average them over the window. Then carve the budget out of the inference buyback share, issue per-wallet API keys, and meter usage against the allowance before standard billing. This is an access right only: no transfer, no cash-out, and nothing paid in tokens or SOL. On-chain locking would need an audited staking program and comes later, if at all.
