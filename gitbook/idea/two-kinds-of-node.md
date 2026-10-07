# Two kinds of node

BRAIN has two supply tiers. They are verified differently, paid through the same hourly pool, and shown side by side on [/network](https://brainnetwork.app/network).

| | Browser node | GPU node |
| --- | --- | --- |
| How to join | Open [/earn](https://brainnetwork.app/earn) | `npm run node` on a machine with `nvidia-smi` |
| Identity | Anonymous persistent id per browser, session token hashed server-side | ed25519 key pair generated on the machine; node id is a hash of the public key |
| Hardware report | Whatever WebGPU exposes, each field with its source; VRAM is always "unavailable" | `nvidia-smi` output, stored as **REPORTED** and never used to raise a score |
| Benchmark | A WGSL integer kernel against a server-seeded secret challenge; the server recomputes secret blocks and times it on its own clock | A pinned, fixed-prompt inference job timed by the coordinator; decode tok/s sets the compute class |
| Work | `matmul_u32` units, canary kernels, one stage of a sharded Qwen3 model | Chat completions on allowlisted open-weight models through vLLM |
| Verification | Bit-exact: secret spot-checks, full-answer canaries, replica agreement for inference stages | Hash, stream consistency, token plausibility, wall time; 5 % of deterministic jobs re-run on a second node; hourly canaries |
| Receipt label | `spot-check` / `canary`, `verified: true` | `node-reported`, `verified: false` |
| Pay | Share of the hourly SOL pool by verified compute units | Same pool, same units, after the wallet is proven by signature |
| Status | **LIVE** since launch | **LIVE**; first real hardware benchmarked 7 October 2026 |

## Why two tiers and not one

Because they are good at different things and lie in different ways.

A browser tab is cheap to open and cheap to fake, so its work is small, deterministic and checkable to the bit. The server knows the right answer to part of every job before the job is sent.

A GPU node runs language models, whose output is not deterministic across hardware and cannot be checked by recomputing a secret block. So the coordinator measures what it can measure directly (did the text match its hash, did the stream match the final answer, is the token count plausible for the length, how long did it take on the coordinator's clock), samples a second opinion from another node, and labels the receipt honestly as `node-reported`.

The two labels are never blurred. A browser receipt says verified because it is. A node receipt says node-reported because the coordinator did not re-run the model. See [Verification](../how/verification.md).

## One pool

Both tiers settle into the same hourly epoch. The unit of account is the same: for parallel work, the integer operations in the unit; for language-model work, `parameters × tokens ÷ 2²⁰` multiply-accumulates, with token counts clipped to the text the coordinator actually streamed. So a tab that verified 64 matmul units and an RTX 4060 that served 300 tokens of Qwen are compared in the same currency, and neither can inflate it from the client side.
