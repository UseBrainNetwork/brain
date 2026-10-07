# Pricing and credits

Demand-side money. This is the least finished part of BRAIN and this page says so.

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
| Purchases | Not possible. `PURCHASE` events are reserved and never written because no payment rail is connected |

## Plans

Free is live. Pro, Code and Max are shown on [/pricing](https://brainnetwork.app/pricing) with their intended prices and contents, labelled **COMING SOON**. Nothing can be purchased and nobody is charged. Model names are not listed on plans because BRAIN routes by capability and the set changes with who is online.

## List prices

Cost on a receipt exists only when the operator has configured a list price: `BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS` for browser work and `BRAIN_PRICE_USD_PER_1M_TOKENS` for inference. Unset means receipts carry `customerCost: null`, rendered UNKNOWN, and the accounting ledger records nothing. The site does not estimate a price in the gap.

## Upstream cost

When BRAIN AUTO routes to an external provider and that provider reports a charge, it is recorded as `INFRASTRUCTURE_COST` with basis `provider-reported`. The customer's price is the configured list price. The two are never blended into a "savings" figure.

## No comparisons

BRAIN has not measured its cost against any other provider and does not display one. Prices on the site that read `$X.XX` are placeholders until there are cost benchmarks, and say so.
