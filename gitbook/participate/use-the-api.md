# Use the API

Change one URL. Run AI on Brain.

## Key

Create an API key under [Account → API keys](https://brainnetwork.app/account). Keys look like `brain_sk_…`, are shown once, and are stored as sha256.

## Request

{% tabs %}
{% tab title="curl" %}
```bash
curl https://brainnetwork.app/v1/chat/completions \
  -H "Authorization: Bearer $BRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen/qwen2.5-1.5b-instruct",
    "stream": true,
    "messages": [{ "role": "user", "content": "explain entropy in one line" }]
  }'
```
{% endtab %}

{% tab title="Python" %}
```python
from openai import OpenAI

client = OpenAI(base_url="https://brainnetwork.app/v1", api_key="brain_sk_...")
r = client.chat.completions.create(
    model="brain/auto",
    messages=[{"role": "user", "content": "hi"}],
)
print(r.choices[0].message.content)
print(r.model_extra["brain"]["target"], r.model_extra["brain"]["receiptId"])
```
{% endtab %}

{% tab title="JavaScript" %}
```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://brainnetwork.app/v1", apiKey: process.env.BRAIN_API_KEY });
const r = await client.chat.completions.create({
  model: "brain/auto",
  messages: [{ role: "user", content: "hi" }],
});
console.log(r.choices[0].message.content);
```
{% endtab %}
{% endtabs %}

## Choosing a model

* A **node model id** from [/models](https://brainnetwork.app/models), such as `qwen/qwen2.5-1.5b-instruct`, runs on Brain Nodes and nowhere else. The page shows live node counts and measured speed per model.
* **`brain/auto`** lets BRAIN AUTO choose across browser compute, Brain Nodes, operator cloud and external models by the published score.

Optional fields:

| Field | Values |
| --- | --- |
| `mode` | `AUTO` (default) · `CHEAP` · `FAST` · `QUALITY` · `BROWSER_ONLY` |
| `privacy` | `PUBLIC` · `STANDARD` (default) · `PRIVATE` |
| `maxCost` | USD ceiling; excludes classes whose known cost exceeds it |
| `maxLatency` | ms ceiling; excludes classes whose known latency exceeds it |

## Privacy

Node models run on hardware BRAIN does not operate, so they are `privacy: public`. A `STANDARD` or `PRIVATE` request pinned to a node model returns `400 privacy_conflict` instead of being routed somewhere else. With `brain/auto`, privacy is a hard filter applied before scoring.

## What comes back

Standard OpenAI-shaped chunks or a completion object, plus:

**Headers:** `brain-request-id`, `brain-target`, `brain-latency`, `x-brain-receipt`, and for node work `brain-node-id`, `brain-region`.

**The `brain` object** (and the stream's closing `event: brain`): route, model, cost, receipt id, and for node work `brain.node = { id, region, reliability, computeClass, routing, verification }`. `routing` is the sentence explaining why that node won. `verification` is the shadow re-run result if one happened.

## When nothing can run it

`503` with every target's exclusion reason, for example:

```json
{
  "error": "no_capacity",
  "targets": {
    "NATIVE_NETWORK": "0 of 4 nodes can serve qwen/qwen2.5-7b-instruct right now (N-895D3F34: VRAM 8 GB < 20 GB required; N-CF66A0F8: offline; …)",
    "EXTERNAL_MODEL": "not configured",
    "BROWSER_NETWORK": "capability chat not supported"
  }
}
```

BRAIN never answers from a target it did not select.

## Verifying a receipt

Fetch the public key from [`/api/coordinator/signer`](https://brainnetwork.app/api/coordinator/signer). Rebuild the canonical body (`v, jobId, nodeId, model, inputTokens, outputTokens, executionMs, timestamp, requestHash, responseHash, hardwareClass, cost`) with sorted keys, sha256 it, and check the ed25519 signature. `verifyReceipt()` in the repository does exactly this and nothing more.

## Limits

Per-IP fixed-window rate limits on every public route; plan rate limits per key (10 requests a minute on Free). Prompt size limits are enforced by the gateway; image parts are rejected rather than dropped. Job output is capped at 200,000 characters.

Full reference: [/developers](https://brainnetwork.app/developers).
