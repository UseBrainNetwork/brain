# Incident log

Every production incident, what caused it, what it cost, and what changed. Times in UTC.

## 2026-10-06 — Database exhausted

**Impact.** The site and every database-backed route were down for several hours. Browser nodes kept heartbeating and were not dropped; no epochs were lost.

**Cause.** The database instance ran out of resources under the load of the first day's traffic.

**Fix.** Instance upgraded. Fail-soft behaviour added: a per-instance circuit breaker so a dead database fails in microseconds instead of tying up every function on connect timeouts; public read routes return their last good body with `stale: true`; the UI shows LIVE DATA DELAYED instead of an error page.

## 2026-10-07 — Settlement contention, then pooler failure

A long day. Three distinct problems, in sequence.

**13:00 to 17:30: database CPU at 97 %.** Two causes. The node view (`/api/nodes/<id>`) read the last 200 jobs for every polling tab every 90 seconds; one statement accounted for 433,000 calls and 83,000 seconds of database time. Separately, settling the 14:00 epoch triggered thirteen serverless instances to aggregate the hour's work at the same moment. **Effect on contributors:** every operator-scheduled baseline job from 13:24 onward failed with zero units, because the job-creation loop (64 unit writes plus one write per online node) was killed by the function time limit before it could assign anything. Those jobs show as `FAILED · 0 nodes · timed out` in the explorer. **Fixes:** node view reads 60 jobs and caches five minutes; tabs poll it every five minutes; the hourly aggregate runs under a Postgres advisory lock so exactly one instance computes it; the settlement route's time limit raised to 300 s.

**15:31 to 18:38: pooler rejected every connection.** The shared connection pooler began returning *"Authentication credentials are invalid. Please reconnect with fresh credentials to restore pool functionality"* for the application's database role, while the database itself was healthy (after a restart: 20 % CPU, 20 of 90 connections). Resetting the password and redeploying did not clear it; the pooler's cached credentials for that role stayed wedged. **Effect:** total outage of every database-backed route; `/economics` showed an error page; heartbeats returned 503. **Fix:** a new database role was created and made owner of the application tables, and the application was pointed at it through the pooler. Pooler pools are per role, so the new role got a fresh one. Service returned at 18:38. Two further hardening changes shipped during the outage: pooler rejections are recognised and retried, and `/economics` renders an unavailable state instead of crashing.

**18:38 to 19:14: no scheduled work dispatched.** The role migration moved the tables but not the job-number sequence, so job creation failed with `permission denied for sequence`. **Fix:** sequence ownership moved. Scheduled job #6218944 dispatched 20 seconds later: 64 units on 42 nodes.

**Epochs.** The 17:00 epoch settled at 18:35 as soon as the database returned (207 wallets). No epoch was skipped; the cron catches up any epoch whose window has closed.

**Open follow-ups.** Prune `brain_jobs` history older than a few days (1.9 GB, the main CPU load). Rotate the credentials that were handled during the incident. Replicate the database or move the pooler dependency behind the store interface.

## 2026-10-08 — Pooler pool poisoned again; deployments disabled

**Impact.** Database-backed routes returned `database_unavailable` for most of the evening (UTC), then every route returned HTTP 402 for about an hour. Browser nodes retried and rejoined; the two native nodes went offline and re-registered after service returned. The 17:00 to 20:00 epochs settled late, none were skipped.

**Cause.** Two unrelated things. The shared pooler's cached credentials for the application role went bad a second time (same *"reconnect with fresh credentials"* symptom as the day before), and the one fallback path, a single session-mode connection, is capped at 15 for the whole project and was saturated. Separately, the hosting account hit its spending cap and every deployment was disabled until the bill was paid; there is no API for that, so it waited on a person.

**Fix.** The store now holds ordered connection lanes: the primary role, a second role with the same privileges, and the session fallback. A lane that the pooler rejects is cooled for ten minutes while the next one serves; the page `/api/health/db` shows lane state. The cap was raised and the site redeployed. Also shipped the same night, after the outage exposed them: a parent job no longer loses unit results that arrive from another instance (`reconcile`), a 64-unit job is written in two statements instead of 130, schema changes are applied by one instance under a lock, and advisory-lock waits no longer pin pooler backends.

## 2026-10-09 — Database disk and write load

**Impact.** No outage. `/api/health/db` flapped to `database_unavailable` for a few minutes around 10:00 UTC while the rest of the site answered; some instances tripped their breaker on slow connections.

**Cause.** The fleet grew from 316 to over 1,700 browser nodes online in twelve hours. Each node took a self-generated job every 3 seconds and every job is a row, so `brain_jobs` grew by about 8 million rows a day to 4.9 million live rows and 8.8 GB, on a disk that was already full. The database was I/O-bound; batch deletes slowed from 7 s to 35 s each.

**Fix.** Self-generated job pacing raised from 3 s to 15 s per node (reward shares between nodes are unchanged; everyone is paced the same). Hourly cron removes browser job rows older than 24 hours in small batches, keeping native work records; 1.74 million rows were removed by hand first. Heartbeats went from every 10 s to every 20 s. An external check now probes the site every five minutes and pages on failure. This page is now also rendered on [/status](https://brainnetwork.app/status). Still open on the operator's side: a larger database tier and credential rotation.

## 2026-10-09 — Native nodes dropped offline

**Impact.** From roughly 04:00 to 12:30 UTC the GPU nodes running the Brain Node agent could not stay registered. Register, heartbeat and work-poll calls timed out from the agent's side, nodes were marked offline, canary jobs failed on deadline, and operators who restarted saw no benchmark arrive. Browser nodes were unaffected. The explorer shows the window as failed `cj-` canaries with no node attached.

**Cause.** The primary database role's pooler pool was poisoned again (the same *"reconnect with fresh credentials"* symptom as on the 7th and 8th). The lane failover from the 8th worked, but each cold serverless instance first waited out the primary lane's 8 s connect timeout plus one retry before cooling it down and moving to the healthy role. On an I/O-bound database that put the first query on every new instance at 8–16 s. The node agent gives a coordinator call 15 s, so from the agent's point of view the coordinator was gone. Browser nodes tolerate slow replies and kept instances warm, which is why they looked fine.

**Fix.** The store takes a `BRAIN_PG_LANE_ORDER` setting and production now tries the healthy role first; `/api/status` reports the lane order and that nothing is cooling. Coordinator routes returned to under two seconds on cold instances. A node agent that is still running reconnects by itself: heartbeats from an offline node bring it back online and the agent retries register and heartbeat indefinitely. Agents that had been stopped need to be started again. Still open on the operator's side: the larger database tier, which is the actual fix for the I/O load, and credential rotation.

## How incidents are recorded

This page is maintained by hand after each incident and is deliberately specific. The lesson from the first week is that the crowd is the robust part of BRAIN and the single database behind it is the fragile part, and the roadmap in [What changes as it grows](../scale/what-changes-as-it-grows.md) reflects that.
