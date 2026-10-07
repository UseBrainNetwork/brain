# Pricing and credits

Demand-side money: what using the network costs, and how that money reaches the people running it.

## The principle

You pay for the answer, not for the model. BRAIN AUTO routes each request to the cheapest path that meets its constraints, and the cost of each answer is on its receipt. A credit is a unit of that real cost: **1 credit = $0.001**.

## Credits today

| | |
| --- | --- |
| Accounts | A signed-cookie identity created on first use; no password |
| Grant | 500 credits a month on the Free plan, from plan config |
| Consumption | `customerCost ÷ 0.001` per request, where `customerCost` comes from the receipt |
| UNKNOWN cost | Consumes 0 credits and is flagged on the receipt |
| Offsets | Verified compute you contribute, from nodes attached to your wallet, is mirrored into your credit balance from REAL `COMPUTE_PROVIDER_EARNED` events |
| Purchases | A paid plan grants its monthly credits as a `PURCHASE` event, one per confirmed on-chain payment, keyed by the payment so it can never be written twice |

## Plans

Free is live and needs nothing. Pro, Code and Max are on [/pricing](https://brainnetwork.app/pricing) and are bought on Solana. Model names are not listed on plans because BRAIN routes by capability and the set changes with who is online.

### Paying

1. You pick a plan and a currency: **USDC** at the USD price, or **SOL** at a live rate. The SOL rate is read from two public price sources that must agree within 2 %; the lower is used, and if they disagree or neither answers, SOL is simply not offered for that moment and USDC remains.
2. The server builds the exact transfer: the amount, to the protocol payout wallet, with a memo naming your payment. Your wallet signs and sends it. BRAIN never holds a key of yours and there is no card.
3. The server reads the transaction back from the chain: it must have succeeded, carry your payment's memo, and move at least the quoted amount to the payout wallet. Only then does the plan activate. A signature can activate a plan once.

A payment buys **30 days**. Paying again for the same plan adds 30 days to the end; paying for a different plan starts that plan now. There is no auto-renew, so nothing is ever charged without a signature from you. When the period ends the account returns to Free; the credits already granted stay.

The money goes to the same wallet that pays contributors, so paid usage is one of the two sources of the epoch pool described in [How contributors are paid](how-contributors-are-paid.md).

### Holding the token

When the operator sets a holding threshold for a plan, a linked wallet that holds at least that many BRAIN has the plan **included while it holds**. Nothing is locked, staked, spent or paid out; the balance is read from the chain by RPC, never self-reported, and re-read every few hours with a 7-day grace window so a slow RPC does not drop anyone mid-week. Sell below the threshold and the account returns to Free at the next check. Holder access is a use of the token, not a return on it: there is no yield and no promise about price. Thresholds, when set, are shown on the plan card; when none is set, the option does not appear.

## List prices

Cost on a receipt exists only when the operator has configured a list price: `BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS` for browser work and `BRAIN_PRICE_USD_PER_1M_TOKENS` for inference. Unset means receipts carry `customerCost: null`, rendered UNKNOWN, and the accounting ledger records nothing. The site does not estimate a price in the gap.

## Upstream cost

When BRAIN AUTO routes to an external provider and that provider reports a charge, it is recorded as `INFRASTRUCTURE_COST` with basis `provider-reported`. The customer's price is the configured list price. The two are never blended into a "savings" figure.

## No comparisons

BRAIN has not measured its cost against any other provider and does not display one. Plan prices are the operator's prices, not a claim about anyone else's.
