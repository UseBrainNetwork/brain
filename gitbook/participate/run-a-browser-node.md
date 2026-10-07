# Run a browser node

Five minutes, nothing installed.

## Requirements

A browser with WebGPU: current Chrome or Edge on Windows, macOS or Linux; Safari 18 or later on macOS; Chrome on Android. Firefox support is partial and depends on your version. A discrete or Apple Silicon GPU gives a higher benchmark score; integrated graphics work and score lower.

## Steps

1. Open [brainnetwork.app/earn](https://brainnetwork.app/earn).
2. **Detect.** The page reads what WebGPU exposes and shows each field with its source. Anything the browser does not expose says *unavailable*. VRAM always does.
3. **Benchmark.** Click to run the challenge. A WGSL kernel runs on your GPU for under a second against a server-seeded secret; the server recomputes secret blocks and scores you on its own clock. Your score is shown with a **LIVE** badge because it was measured in your tab and verified on the server.
4. **Join.** Your node appears in the topology, the join counter increments by exactly one, and work starts arriving within seconds.
5. **Connect a wallet.** Phantom, Solflare, Backpack, or an email through Privy. Sign one message; it moves no funds. Verified units from your tab are attributed to this wallet.

Leave the tab open. Minimise it, move it to another desktop, do not close it.

## What you will see

* **Jobs completed, verified compute, reputation** on the dashboard, all server-computed and badged LIVE.
* **This epoch accrued**: your verified work so far against the current pool, pro-rated to elapsed time. It becomes a real allocation when the hour settles.
* Your node's page at `/node/<id>`: verification rate, reassignment rate, median latency, uptime, all from server records.

## Claiming

At two minutes past each hour the previous hour settles. On [/rewards](https://brainnetwork.app/rewards), connect the same wallet and claim. You sign a message binding the amount, a nonce and an expiry; the server sends SOL from the payout wallet and shows you the transaction signature. One pending claim per wallet; per-claim and daily caps apply.

## Things worth knowing

* **Several tabs on one machine** compete for one GPU and do not earn more than one tab. The server's reassignment and plausibility checks make a fake second GPU pointless.
* **A closed laptop lid** stops the tab. Set your machine not to sleep if you want it to keep working.
* **Deploys reach you automatically.** A long-lived tab reloads itself at an idle moment when a new build ships.
* **If the site shows LIVE DATA DELAYED**, the database is unreachable. Your tab keeps heartbeating and is not dropped; the figures catch up when it returns.
* **The amount per hour is small and varies.** A fixed pool is split by everyone's verified work. More contributors means less each unless the operator raises the pool. The site shows the pool and the runway so you can see this for yourself.

## What earns nothing

Being open without verifying units. Holding tokens without working. Reporting a better GPU than you have (it is ignored). Running the benchmark again (benchmarks are not paid). Browser inference stages that ran without a replica (recorded as `no-replica`).
