# The reward formula

Source: `rewards/formula.ts`. Parameters: `rewards/config.ts`. Guarantees: `rewards/formula.test.ts`. Nothing below is a magic number; every knob is named in the config.

## Inputs per wallet

| Input | Source |
| --- | --- |
| `verifiedCompute` | Sum of verified units in the epoch, from server job records |
| `tokenAmount` | SPL balance read by RPC, or 0 when unconfigured |
| `reliability` | 0–1, from the reputation system |
| `jobsAssigned`, `jobsCompleted` | Server job records |
| `availability` | 0–1, 5-minute buckets with an assigned job ÷ 12 |
| `verificationPassRate` | 0–1, verified results ÷ checked results |

## Eligibility

A wallet earns nothing from the epoch if any of these hold:

* `banned`
* `verifiedCompute ≤ minVerifiedCompute` (0) — **no verified compute, no reward**
* `verificationPassRate < 0.9`

## The formula

```
computeShare_i = verifiedCompute_i / Σ verifiedCompute
tokenShare_i   = min(holdings_i / supply, 0.01)              ← anti-whale cap at 1 % of supply

normCompute_i  = computeShare_i · N                          ← 1.0 = the average wallet
normToken_i    = (tokenShare_i / mean(tokenShare))^1         ← exponent 1 = Sybil-neutral

effToken_i     = max(normToken_i, 0.5 · normCompute_i)       ← non-holders credited with λ = 0.5
baseScore_i    = sqrt(normCompute_i · effToken_i)            ← geometric mean
multiplier_i   = min(baseScore_i / (√0.5 · normCompute_i), 1.35)
quality_i      = reliability^1 · completionRate^1 · availability^0.5
score_i        = √0.5 · normCompute_i · multiplier_i · quality_i

rewardWeight_i = score_i / Σ score, then water-filled under the per-wallet cap
payout_i       = rewardWeight_i · pool
```

## The cap

No wallet takes more than `maxNodeShareOfPool` = 2 % of an epoch once the network is large. While few wallets are eligible, the effective cap is `clamp(1 / eligibleWallets, 0.02, 0.25)`, so a handful of early wallets can actually receive the pool instead of most of it returning undistributed. Whatever the caps leave undistributed stays in the payout wallet.

## Properties, each with a test

| Property | Why it holds |
| --- | --- |
| Zero verified compute ⇒ zero reward, regardless of holdings | `normCompute = 0` makes `score = 0`; eligibility also rejects it |
| A non-holder's score is linear in compute (Sybil-neutral) | With `effToken = λ·normCompute`, `baseScore = √λ · normCompute` and the multiplier is exactly 1 |
| Splitting a wallet does not help | Exponent 1 on token weight; compute shares add linearly |
| Every wallet's reward is bounded by a constant times its own verified compute | The multiplier is capped at 1.35 |
| Holding more than 1 % of supply adds nothing | `tokenShareCap` |
| An average proportional holder earns at most √(1/λ) ≈ 1.41× before the 1.35 cap | From the geometric mean |

## Worked example

Three wallets in one hour, with a pool of **P** SOL (whatever the operator has set that hour), all with perfect quality:

| Wallet | Verified units | Tokens | normCompute | multiplier | score | share | payout |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 600 | 0 | 1.80 | 1.00 | 1.273 | 0.543 | 0.543 P |
| B | 300 | large | 0.90 | 1.35 | 0.859 | 0.366 | 0.366 P |
| C | 100 | 0 | 0.30 | 1.00 | 0.212 | 0.090 | 0.090 P |
| D | 0 | enormous | 0 | — | 0 | 0 | 0 |

A does twice B's work and gets about 1.5× B's pay, because B's holdings earn the capped multiplier. D holds the most tokens of anyone and receives nothing. (Scores shown use √0.5 ≈ 0.707 and are rounded; the per-wallet cap of 25 % for three eligible wallets then water-fills A down to 0.25 P and redistributes the rest to B and C in production, which the example omits for readability.)

## What the formula does not do

It does not pay for uptime alone; availability is a quality exponent on compute, and 100 % uptime with zero verified units is still zero. It does not pay for reputation alone, for the same reason. It does not compound, vest, or lock. It does not reference a token price anywhere.
