# Track everything

Every claim in this book can be checked against a public surface. This page lists them.

## Pages

| Page | What it shows | Source |
| --- | --- | --- |
| [/network](https://brainnetwork.app/network) | Devices online, capacity, jobs, success rate, dedicated nodes with reported and measured columns, live feed, request-path animation | Server records and the event bus; animation pulses are real jobs |
| [/explorer](https://brainnetwork.app/explorer) | Every job and receipt; ids ≥ 5,000,000 are real | Server records |
| [/economics](https://brainnetwork.app/economics) | Accounting cells (REAL only), creator rewards, treasury figures, payout wallet, allocated, claimed, owed, pool per epoch, runway | Accounting ledger and chain-rebuilt treasury |
| [/rewards](https://brainnetwork.app/rewards) | Your epochs, allocations, claims | Settlement records for your wallet |
| `/epoch/<id>` | One settled epoch: participants, pool, distributed, allocation hash | Written once at settlement |
| `/receipt/<id>` | One receipt with every field and its basis | Server records |
| `/node/<id>` | One browser node's history | Server job and heartbeat records |
| `/provider?node=<id>` | One GPU node: state, reported hardware, measured outcomes, reliability, earnings | Coordinator registry |
| [/capacity](https://brainnetwork.app/capacity) | What the network can run today, honestly labelled | Registry and allowlist |

## Endpoints

| Endpoint | Returns |
| --- | --- |
| [`/api/stats`](https://brainnetwork.app/api/stats) | `nodesOnline`, `nodesJoined`, `jobsCompleted`, `workUnitsVerified`, `verifiedComputeUnits`, `successRate`, `backend`, `stale` |
| [`/api/treasury`](https://brainnetwork.app/api/treasury) | Fees received, deposits, payout funding, withdrawals, balances, allocated, claimed, owed, pool per epoch, runway, source signatures |
| [`/api/coordinator/nodes`](https://brainnetwork.app/api/coordinator/nodes) | Every GPU node with `reported`, `measured`, `benchmark`, `reputation`, `verification` |
| `/api/jobs` | Recent distributed jobs with full lifecycle |
| `/api/receipts` | Recent receipts |
| [`/api/coordinator/signer`](https://brainnetwork.app/api/coordinator/signer) | The receipt-signing public key |
| `/api/network/stream` | Server-sent events: joins, verifications, job transitions. Never prompts, outputs, IPs, wallets or keys |

## On chain

| What | Where |
| --- | --- |
| Every contributor payout | Outbound transfers from [`7TSAzUKLyCPb5AqzXUPMy4mTwVj4sdng2Gu2omSsaxVF`](https://solscan.io/account/7TSAzUKLyCPb5AqzXUPMy4mTwVj4sdng2Gu2omSsaxVF) |
| Creator-fee claims and payout funding | Transactions on [`HZLev74M3ATV5jQJsoN8FcJAKx3RUefAobhcXr3egxwa`](https://solscan.io/account/HZLev74M3ATV5jQJsoN8FcJAKx3RUefAobhcXr3egxwa) |
| Your claim | The signature shown on `/rewards` after you claim |

## In the repository

[github.com/UseBrainNetwork/brain](https://github.com/UseBrainNetwork/brain). The files that matter most:

* `REAL_VS_SIMULATED.md`: the authoritative list of what is real, what is simulated and what is estimated.
* `ROUTING.md`: the resource-class router weights per mode.
* `docs/architecture.md`, `docs/security.md`: the engineering and threat model this book summarises.
* `rewards/formula.ts`, `rewards/config.ts`, `rewards/formula.test.ts`: the reward formula, its knobs, and the guarantees.
* `services/router/score.ts`: the node router.
* `services/coordinator/verify.ts`: shadow re-runs and canaries.
* `services/treasury.ts`: how the ledger is rebuilt from chain.

## A simple audit anyone can do

1. Read `/api/treasury`. Note `distributed` (claimed SOL).
2. Open the payout wallet on an explorer. Sum its outbound transfers to addresses other than the protocol wallet.
3. They should match to the lamport, less network fees.

If they do not, open an issue. That is what the public record is for.
