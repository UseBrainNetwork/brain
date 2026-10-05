# Contributing

Thanks for looking. A few rules keep this project honest; please read them before opening a PR.

## Non-negotiables

1. **Never trust the client.** GPU model, compute units, job completion, benchmark score and uptime are display-only unless the server measured or verified them.
2. **Never mix real and simulated.** Demo data lives in `services/mock/` and is tagged `SIM`. A real value is tagged `LIVE`. One figure never combines both.
3. **Unknown is a valid value.** If a price, a hardware field or a metric is not known, render `UNKNOWN` / `unavailable`. Do not estimate, interpolate or invent.
4. **No secrets client-side.** Only `NEXT_PUBLIC_BRAIN_WS_URL` is public. Everything else is server env.
5. **Zero verified compute → zero compute reward.** Tests enforce this; keep them green.
6. **No emissions, staking, points, quests, NFTs, licenses, promised returns.**

## Workflow

```bash
npm install
npm run dev            # port 3000
npm run typecheck
npm test
npm run build
```

End-to-end flows run in headless Chrome with real WebGPU (`scripts/flow.mjs`, `scripts/multitab.mjs`, `scripts/phase2.mjs`). Run them with a built server before touching the contributor pipeline, verification or the store.

## Pull requests

- One concern per PR. Describe what is real vs simulated if the change touches displayed numbers.
- Include tests for anything in `services/`, `rewards/`, `engine/`, `network/workloads.ts` or `webgpu/`.
- Visual changes: attach screenshots at 1440 px and 390 px.
- Update `REAL_VS_SIMULATED.md` if provenance changes, and `ECONOMICS.md` if pricing or splits change.

## Design

Cool graphite, one signal color (cobalt) for work in flight, green only for verified work. Geist + JetBrains Mono. No AI orbs, purple gradients, cartoon brains or generic crypto styling. Animations must show real system behavior.
