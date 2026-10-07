# What we refuse to fake

Most distributed-compute projects die of the same disease: the dashboard is more impressive than the network. BRAIN was built with a short list of things it will not do, and the list is enforced in code and tests, not in a values page.

## Never trusted from the client

Contributors are assumed to be adversarial. The server does **not** trust any of the following when a browser or node reports it:

* GPU model or name
* VRAM
* Compute units completed
* Job completion
* Benchmark score
* Uptime
* Token counts beyond what the coordinator streamed itself

Reported values are stored as `reported`, labelled **REPORTED** wherever they are shown, and used only to *exclude* a node (a card that reports 8 GB is never sent a model that needs 20 GB). They never raise a score or a payout.

## Never mixed

Every receipt, accounting event, order, treasury record, epoch and credit event carries `source: "REAL" | "SIMULATED"`. Stores index on it, snapshots filter on it, and the test suite asserts that simulated data cannot enter a real total, that a simulated earning can never offset credits, and that a client cannot self-report verified compute.

By default the site shows **real only**. A footer control, "Show simulated data", blends a simulated network in for people who want to see how the product reads at scale, and every such figure gets a **SIM** badge. The choice lives in your browser; it changes nothing on the server.

## Never claimed

* No TFLOPS or VRAM figures. Browsers do not expose VRAM, so BRAIN does not display it.
* No fabricated benchmark results. Every score shown for your device was measured in your tab and verified by the server.
* No "X % cheaper than" comparisons. BRAIN has not measured one and will not invent one.
* No token emissions, no staking yield, no price expectations.
* No cryptographic proof of execution. The receipt's `resultHash` is an integrity digest anyone can recompute; `attestation` is `{ kind: "none" }` for browser work and `{ kind: "signature" }` for coordinator-signed node receipts. Hardware attestation is **PLANNED** and labelled so.
* No "verified" label on an upstream model's response. If BRAIN AUTO routes to an external provider, the receipt says `unverified-provider-response`.
* No revenue, customers or savings that are not in the accounting records. Unpriced work is **UNKNOWN**, not estimated.

## Zero verified compute, zero reward

This is the load-bearing rule. A wallet with no verified compute in an epoch receives nothing from that epoch, no matter what it holds, how long it was online, or what it reported. The reward formula has a test for it. Benchmark jobs and canaries issue no receipt and earn nothing. The accounting ledger accrues only from receipts.

If you remember one thing from this book, make it this one.
