# When the database goes away

BRAIN has one Postgres database and no daemon. Every serverless function talks to it through a shared connection pooler. That is cheap and simple, and it is also the single component whose failure the network has actually experienced, twice in its first three days. This page is what the code does about it.

## The circuit breaker

`PgStore` has a per-instance breaker. Two consecutive connection failures open it for 15 seconds, during which every query fails in microseconds with `StoreUnavailableError` instead of each waiting out an 8-second connect timeout. One probe per window closes it. Routes answer `503 database_unavailable` with `Retry-After`.

## Stale bodies instead of invented ones

Public read routes (`/api/stats`, `/api/network/real`, `/api/coordinator/nodes`, `/jobs`) keep their last successfully built response and return it with `stale: true` and `asOf` while the database is unreachable. The UI shows **LIVE DATA DELAYED**. If there is no previous body, the route returns a fast 503, never a made-up one. The CDN layer adds `stale-if-error=3600` so it keeps serving the last good body too.

## Pooler rejections

The shared pooler has its own failure modes, distinct from the database being down: a per-project client cap (`max client connections reached`) and a stuck authentication state (`Authentication credentials are invalid. Please reconnect with fresh credentials`). Both are recognised by `isPoolerRejection()`, counted as connectivity errors for the breaker, and retried once with a short backoff before failing.

## Single-flight aggregation

Settlement needs to aggregate every job in the hour. Thirteen serverless instances deciding to do that at the same moment is what pushed the database to 97 % CPU on 7 October. Now the aggregate runs under a Postgres advisory lock keyed by the window, so exactly one instance computes it; the others wait on a shared `meta` document and read the result, falling back to the newest stale aggregate for live windows.

## Pages degrade, they do not die

`/economics` renders an "unavailable" state for the token and protocol-wallet cards when the store is unreachable, instead of a crash page. Browser nodes keep heartbeating through a 503 and are not dropped.

## What is still fragile

* One database, one region. A regional outage takes the control plane down; nodes keep their identities and reconnect when it returns, but no work is dispatched meanwhile.
* The connection pooler is shared infrastructure BRAIN does not operate. When its per-user pool wedged on 7 October, the fix was to connect as a different database role, which is a workaround and not a design.
* The jobs table grows by roughly a million rows per day at current volume and is the main CPU load. Pruning history older than a few days is on the list.

The full narrative of both outages is in the [incident log](../trust/incident-log.md).
