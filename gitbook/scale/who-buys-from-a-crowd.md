# Who buys from a crowd

A network of strangers' hardware is not for everyone. This page is about who it is for, and it begins with who it is not for, because that is where the dishonest version of this story usually starts.

## Not for

**Frontier labs.** The companies training and serving the largest models run on tightly interconnected datacenter accelerators with terabytes per second of bandwidth between them. A crowd of consumer cards over the public internet cannot supply that, and anyone telling you a browser network will "provide GPUs" to those companies is selling something. BRAIN does not supply GPUs to anyone. It supplies answers and verified compute.

**Workloads where the prompt is secret.** Node operators can read what runs on their machine. BRAIN enforces this honestly: a `STANDARD` or `PRIVATE` request cannot be routed to the crowd, and asking for privacy on a node-only model is a `400`, not a silent reroute. Until there is an attested confidential-compute tier, private workloads go to operator cloud or an upstream.

**Workloads that need one huge model.** See [Honest limits](honest-limits.md).

## For

**Developers who buy inference, not hardware.** Most teams do not want a GPU; they want `chat.completions.create()` to return quickly and cheaply. BRAIN's `/v1` endpoint is drop-in for the OpenAI SDK. A developer who changes one URL gets open-weight models served from the crowd and dedicated nodes, with a receipt on every response that says where it ran and how it was verified.

**Agent builders.** Agent loops make many small calls: classify, extract, decide, call a tool, summarise. Each call is cheap and the volume is high. That is precisely the small-model, many-parallel-instances shape the crowd is good at, and `brain/auto` with `mode: CHEAP` is built for it.

**Batch and evaluation workloads.** Embed a corpus. Score ten thousand candidates. Run an eval suite across a model's outputs. These split into independent units with a clear completion time, which is the distributed-job shape BRAIN already runs for its own verification work.

**Anyone who wants a receipt.** A signed statement of model, node, tokens, execution time and verification method, checkable offline against a published key. Buyers in regulated or audited contexts care about this more than about the last cent of price.

**Privacy-first products that want no logs.** A product whose promise is "we remember nothing" needs inference it does not control the logs of. Routing through a network that returns a receipt and keeps no prompt text on any public surface is a fit. Prompts never appear on BRAIN's public SSE stream or in its public job records.

**Node operators themselves.** Compute you contribute offsets what you use: verified work from nodes attached to your wallet is mirrored into your credit balance. A developer who runs a node pays for their own inference with their own idle GPU.

## How they pay

Today, with credits, from a monthly Free grant. Payment rails are not connected and the site says so on every plan that is not Free. When they are, the price of a request is its receipt cost at the configured list price, and nothing is marked up by an undisclosed margin: the accounting ledger records the provider share and the protocol share of every priced receipt separately.

## How they know it worked

They read the receipt. `verificationMethod` tells them whether the server checked the work bit-exactly, measured and sampled it, or merely relayed it. `brain.node.verification` tells them whether a shadow re-run agreed. The `brain-node-id` header tells them which machine answered, and `/provider?node=<id>` shows them that machine's history. No other provider hands over that much.
