# FAQ

**Is this real or a demo?**
Real by default. The site shows only server-measured figures unless you turn on "Show simulated data" in the footer, and then every simulated figure carries a SIM badge. 11.10 SOL has been paid to contributors on-chain as of 7 October 2026. The full list of what is real, simulated and estimated is in [Real vs simulated](real-vs-simulated.md).

**How much will I earn?**
Unknown, and anyone who gives you a number is guessing. A fixed pool of SOL per hour, shown live on /economics, is split by verified work among everyone who did any. More contributors means less each. The site shows the pool, the runway, and your accrued share this hour so you can see the arithmetic for yourself.

**Do I need to hold the token to earn?**
No. Holding raises your weight by at most 1.35× and only on work you actually verified. A wallet full of tokens that did no work earns zero. A wallet with no tokens that did work earns in proportion to it.

**Is this staking?**
No. There is no return on holding. There are no emissions. The pool is SOL from trading fees already earned.

**Will the token go up?**
This book does not say, imply or model anything about the token's price. Nothing on the site does either.

**Can I fake my GPU?**
You can report whatever you like and it will be ignored. Benchmarks are server-seeded and server-timed. Work is verified against secrets the server knows. A faster-than-possible result is rejected. Reported hardware can only exclude you from work, never get you more.

**Can I run many tabs on one machine?**
They share one GPU and do not earn more than one tab would. The server's reassignment, plausibility and reputation handling make it pointless.

**Is my prompt private?**
On the browser crowd and on GPU nodes, no: the operator of the machine can read it. BRAIN enforces this by rule: `STANDARD` and `PRIVATE` requests cannot be routed there, and asking for privacy on a node-only model returns `400 privacy_conflict`. Prompts never appear on any public surface of the site.

The chat at `/chat` defaults to `PUBLIC`, so a community GPU may answer and its operator can read the prompt; the composer says so and `STANDARD` is one tap away. On the free plan a `PUBLIC` request goes to a community GPU first whenever one can take it (`COMMUNITY` mode, see [Routing](../how/routing.md)); paid plans keep the AUTO ranking unless they choose otherwise. The API defaults to `STANDARD`. The `GPU` option in the chat sends the request to community GPUs by name and is always `PUBLIC`.

**Is node inference verified?**
Not bit-exactly, and the receipt says so (`node-reported`, `verified: false`). The coordinator checks the response hash, stream consistency, token plausibility and wall time on its own clock, re-runs 5 % of deterministic jobs on a second node, and runs hourly canaries. Those probes move the node's reliability score. Browser work and network-inference stages are verified exactly and say `verified: true`.

**Can the crowd run a 70B model?**
No. See [Honest limits](../scale/honest-limits.md). It can run 0.6B to 4B models pipeline-sharded across tabs, and dedicated consumer cards can serve 7B to 14B models alone.

**Does BRAIN supply GPUs to the big AI labs?**
No, and it will not. They need interconnected datacenter accelerators. BRAIN supplies answers and verified compute to developers through an OpenAI-compatible endpoint. See [Who buys from a crowd](../scale/who-buys-from-a-crowd.md).

**Where does the SOL come from?**
Creator fees from trading the token on pump.fun, claimed on-chain to the protocol wallet and moved to the payout wallet. Every step is a Solana transaction you can read. See [Treasury and runway](../economics/treasury-and-runway.md).

**What happens when the payout wallet runs out?**
Epochs still settle and allocations are written, but claims fail until the operator moves more SOL in. The runway on `/economics` shows how many hours are left at the current pool. Nothing is borrowed.

**What is a work unit?**
For browser jobs, one row block of an integer matrix multiplication. For inference, `parameters × tokens ÷ 2²⁰` multiply-accumulates, with tokens clipped to what the coordinator streamed. Both are counted only when verified.

**Why did my job fail with "timed out · 0 nodes"?**
If it was on 7 October 2026 between 13:24 and 19:14 UTC, see the [incident log](incident-log.md). Otherwise the job could not be assigned before its deadline; the lifecycle on `/explorer/job/<id>` says why.

**Who runs this?**
One team, one coordinator, one database, at the time of writing. The hardware belongs to the people running it. The roadmap toward more than one coordinator is in [What changes as it grows](../scale/what-changes-as-it-grows.md), honestly labelled PLANNED.

**Is the code open?**
Yes: [github.com/UseBrainNetwork/brain](https://github.com/UseBrainNetwork/brain).
