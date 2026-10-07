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

## How incidents are recorded

This page is maintained by hand after each incident and is deliberately specific. The lesson from the first week is that the crowd is the robust part of BRAIN and the single database behind it is the fragile part, and the roadmap in [What changes as it grows](../scale/what-changes-as-it-grows.md) reflects that.
