# Integrations

BRAIN speaks the OpenAI Chat Completions format, so anything with an "OpenAI compatible" slot already works. Three values, every time:

| Setting | Value |
| --- | --- |
| Base URL | `https://brainnetwork.app/v1` |
| API key | your `brain_sk_…` key from Account → API keys |
| Model | `brain/auto` (or `brain/code`, `brain/qwen`, any id from `/v1/models`) |

BRAIN's extra request fields (`mode`, `privacy`, `node`, `retries`, `fallback`, `timeout_ms`) go through each framework's extra-body hook. Other servers ignore them. The receipt id is on the `x-brain-receipt` response header and the verify link on `x-brain-receipt-url`, so frameworks that hide the `brain` JSON block still give you the audit trail.

## Vercel AI SDK

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

const brain = createOpenAICompatible({ name: "brain", baseURL: "https://brainnetwork.app/v1", apiKey: process.env.BRAIN_API_KEY, includeUsage: true });

const { text, response } = await generateText({ model: brain("brain/auto"), prompt: "Summarize this audit report." });
console.log(response.headers?.["x-brain-receipt-url"]);
```

## LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="brain/auto", base_url="https://brainnetwork.app/v1", api_key=os.environ["BRAIN_API_KEY"],
                 extra_body={"mode": "cheap", "retries": 1, "fallback": True})
print(llm.invoke("Summarize this audit report.").content)
```

```ts
import { ChatOpenAI } from "@langchain/openai";

const llm = new ChatOpenAI({ model: "brain/auto", apiKey: process.env.BRAIN_API_KEY, configuration: { baseURL: "https://brainnetwork.app/v1" }, modelKwargs: { mode: "quality" } });
```

## LiteLLM

```python
litellm.completion(model="openai/brain/auto", api_base="https://brainnetwork.app/v1", api_key=os.environ["BRAIN_API_KEY"], messages=[...])
```

```yaml
model_list:
  - model_name: brain
    litellm_params:
      model: openai/brain/auto
      api_base: https://brainnetwork.app/v1
      api_key: os.environ/BRAIN_API_KEY
```

## Editors and agents

* **Cursor**: Settings → Models → OpenAI API Key: paste your key, enable "Override OpenAI Base URL" with `https://brainnetwork.app/v1`, add a custom model named `brain/auto` or `brain/code` and select it. Cursor features that require its hosted models keep using them.
* **Continue** (`.continue/config.yaml`): `provider: openai`, `model: brain/code`, `apiBase: https://brainnetwork.app/v1`, `apiKey: ${{ secrets.BRAIN_API_KEY }}`.
* **Cline, Roo Code, Aider, Open WebUI, anything else**: pick the OpenAI-compatible provider and enter the three values above.

## Command line

A zero-dependency Node 18+ script. One file; read it before you run it.

```bash
curl -fsSL https://brainnetwork.app/cli.mjs -o brain.mjs
export BRAIN_API_KEY=brain_sk_…

node brain.mjs chat "Summarize this file" < notes.txt   # route, model, latency, cost basis, receipt link on stderr
node brain.mjs models
node brain.mjs receipt r-ij-…                            # re-verifies the ed25519 signature locally
node brain.mjs receipts --days 30 --csv > october.csv
node brain.mjs quote "Hello" --currency sol              # pay-per-call 402 quote, no key needed
node brain.mjs stats
```

`chat` accepts `--model`, `--system`, `--json`, `--max-tokens`, `--mode`, `--privacy`, `--node`, `--retries`, `--fallback`, `--timeout`, `--no-stream`, `--quiet`. `BRAIN_HOST` points it at another gateway. The same file lives in the repository at `sdk/cli/brain.mjs` as package `@brainnetwork/cli` (bin `brain`).

## Pay per call from code

`sdk/pay-per-call.ts` in the repository does the 402 → pay → redeem flow with `@solana/web3.js` and a `maxUsd` guard. See [Use the API](use-the-api.md#pay-per-call-no-account).
