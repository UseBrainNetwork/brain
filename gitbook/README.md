---
description: >-
  BRAIN turns ordinary computers into one AI compute network. This book explains
  exactly how, what is real today, and what happens as the crowd grows.
---

# The crowd is the GPU

Every laptop, desktop and gaming PC on earth has a GPU that sits idle most of the day. Meanwhile AI inference runs in a handful of datacenters that are expensive to build, booked out, and owned by very few companies.

BRAIN connects those two facts. Open a browser tab and your GPU is measured, verified and put to work. Run a small agent on a machine with an NVIDIA card and it serves open-weight language models to developers. Send a request to an OpenAI-compatible endpoint and it is routed to whichever machine can answer it cheapest and prove that it did.

This book is the full account of how that works: the routing formula, the verification rules, how the hourly SOL pool is split, where every coin comes from and goes to, and what the network becomes as it grows from a few hundred devices to a provider nobody owns.

{% hint style="info" %}
**How to read the labels.** Every component of BRAIN carries one of three tags, and this book uses them the same way the code does.

* **LIVE** — deployed in production, exercised by tests, producing figures from real records.
* **DEMO** — works end to end on a labelled mock. Never mixed with LIVE figures.
* **PLANNED** — an interface or stub exists so the shape is visible. It does nothing yet.

If a number is not measured, it is shown as **UNKNOWN**, not estimated.
{% endhint %}

## The network right now

Numbers move; the page that reads them live is [brainnetwork.app/network](https://brainnetwork.app/network) and the machine-readable source is [`/api/stats`](https://brainnetwork.app/api/stats). The snapshot below was taken on **7 October 2026 at 19:25 UTC**, three days after launch, and is included so you can see what the words in this book refer to.

| | |
| --- | --- |
| Devices online | 619 |
| Devices that have joined since launch | 7,092 |
| Dedicated GPU nodes registered | 4 (RTX 4060, RTX 3070, RTX 3060, RTX 3050 laptop) |
| Work units verified | 2,259 |
| Verified compute units | 2,660,446 |
| SOL paid to contributors since launch | 11.10 |
| Payout wallet | [`7TSAzUKLyCPb5AqzXUPMy4mTwVj4sdng2Gu2omSsaxVF`](https://solscan.io/account/7TSAzUKLyCPb5AqzXUPMy4mTwVj4sdng2Gu2omSsaxVF) |

## Where to start

| If you are | Start here |
| --- | --- |
| Curious what this is | [What BRAIN is](idea/what-brain-is.md) |
| Going to open a tab and earn | [Run a browser node](participate/run-a-browser-node.md) |
| Running an NVIDIA machine | [Run a GPU node](participate/run-a-gpu-node.md) |
| Building with the API | [Use the API](participate/use-the-api.md) |
| Checking whether any of this is real | [Real vs simulated](trust/real-vs-simulated.md), then [Track everything](participate/track-everything.md) |
| Thinking about where this goes | [The shape of the network](scale/the-shape-of-the-network.md) |

## One paragraph for the impatient

You ask. BRAIN finds the cheapest computer that can answer, sends you the answer with a receipt, and pays the computer that did the work. Your computer can be one of those computers. Only verified work earns. Everything is on-chain or in a public ledger you can read.

{% hint style="warning" %}
BRAIN is experimental software, three days old at the time of writing. It has already had two production outages, both described in the [incident log](trust/incident-log.md). Rewards are not guaranteed and nothing here is investment advice.
{% endhint %}
