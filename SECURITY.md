# Security

brain assumes contributors are adversarial and treats every client-reported value as untrusted. If you find a way to earn credit without doing verified work, to learn the server's secret spot-check rows, to read another node's or wallet's data, or to extract any provider credential, we want to know.

## Reporting

Open a private vulnerability report through GitHub's **Security → Report a vulnerability** on this repository. Include reproduction steps and the commit you tested against. We acknowledge within 72 hours.

Please do not file public issues for security problems, and do not test against other contributors' devices or wallets.

## In scope

- Verification bypass: getting a unit marked verified with a wrong or skipped result.
- Benchmark inflation that survives the server-timed challenge.
- Reputation or reward manipulation (Sybil splits, replay, cap evasion).
- Secret leakage: provider keys, server secret, spot-check indices, expected outputs.
- Auth and signing: session token forgery, wallet nonce replay, claim double-spend.
- Store concurrency: lost updates or stuck jobs under concurrent unit results.

## Out of scope

- Simulated / demo numbers (clearly labeled `SIM` in the UI). They are not claims.
- Denial of service against the public demo.
- Issues in third-party providers reached through the gateway.

## Hard rules the code is held to

- Secrets exist only in server env. The client bundle is checked for secret names and values.
- Zero verified compute must always produce zero compute reward.
- Real and simulated values are never combined into one figure.
