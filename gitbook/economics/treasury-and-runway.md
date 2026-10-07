# Treasury and runway

BRAIN does not keep a running total of its own money. It reads the chain and rebuilds the picture from transactions, every time. If the figure on [/economics](https://brainnetwork.app/economics) disagrees with a block explorer, the block explorer is right and the site has a bug; that is the intended failure direction.

## The wallets

| Wallet | Address | Role |
| --- | --- | --- |
| Protocol | [`HZLev74M3ATV5jQJsoN8FcJAKx3RUefAobhcXr3egxwa`](https://solscan.io/account/HZLev74M3ATV5jQJsoN8FcJAKx3RUefAobhcXr3egxwa) | Receives creator-fee claims from the pump.fun vault |
| Payout | [`7TSAzUKLyCPb5AqzXUPMy4mTwVj4sdng2Gu2omSsaxVF`](https://solscan.io/account/7TSAzUKLyCPb5AqzXUPMy4mTwVj4sdng2Gu2omSsaxVF) | Funds epochs; sends every contributor claim |

The server holds the payout wallet's key (it has to, to send claims) and never the protocol wallet's.

## How the ledger is built

The `pumpfun` adapter pages through every transaction on the protocol wallet and classifies each by signature:

| Kind | Meaning |
| --- | --- |
| `creator_fee` | A claim out of our pump.fun vault program accounts into the protocol wallet |
| `deposit` | Any other inbound SOL |
| `payout_funding` | A transfer from the protocol wallet to the payout wallet |
| `withdrawal` | Any other outbound SOL |

`POST /api/treasury {"action":"rescan"}` (operator only) resets the cursor and replays the whole history. Wallet balances are read live by RPC and shown as **UNKNOWN** when RPC is down. Unclaimed fees still sitting in the vault are shown as such and never counted as treasury.

## What is owed

* **Allocated** = Σ `distributedLamports` over every live epoch.
* **Claimed** = Σ successful claims.
* **Owed** = allocated − claimed.
* **Runway** = (payout wallet balance − owed) ÷ pool per epoch, in epochs.

Runway is the honest number: how many more hours the current wallet can pay at the current pool before the operator must move more SOL in. When it reaches zero, epochs still settle (allocations are written) but claims fail until the wallet is topped up. Nothing is borrowed from a future that has not happened.

## The picture on 7 October 2026, 19:25 UTC

| | SOL |
| --- | --- |
| Creator fees received by the protocol wallet | 29.78 |
| Other deposits | 10.90 |
| Withdrawn from protocol wallet | 40.68 |
| Protocol wallet balance | 0.00 |
| Payout wallet balance | 4.04 |
| Allocated across live epochs | 14.09 |
| Claimed by contributors | 11.10 |
| Owed, unclaimed | 2.99 |
| Pool per epoch | 0.15 |
| Runway | ≈ 7 epochs |
| Unclaimed in the pump.fun vault (not counted) | ≈ 25.6 |

Two things that picture shows honestly: the payout wallet is nearly empty relative to what has been promised, and there is a large unclaimed balance in the vault that would refill it. Both are the operator's job, both are visible to everyone, and the site will show the runway dropping hour by hour until the transfer happens.

## The one inbound the payout wallet has ever had

14.998795 SOL on 5 October 2026 at 12:25 UTC, from `GsgozMnMq295ppiyf3hsuNd73LdyK1CWVbLm1t3vWHhH`. Every contributor claim since has been paid out of that one deposit. You can verify this on any Solana explorer; the site shows the same transactions under the payout wallet's history.

## Live source

[`GET /api/treasury`](https://brainnetwork.app/api/treasury) returns the full structure: figures, balances, allocated, claimed, owed, runway, and the list of transaction signatures the ledger was built from.
