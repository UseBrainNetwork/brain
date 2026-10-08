-- BRAIN network store. Postgres 14+ (or any Postgres-compatible: Neon, Supabase, CockroachDB*).
-- Documents are stored as JSONB with the columns we query on lifted out and indexed.
-- Work aggregates (services/pgStore.ts aggregateWork) are cached in brain_documents as kind 'meta', id 'agg:*'.

CREATE SEQUENCE IF NOT EXISTS brain_job_seq START 5000001;

CREATE TABLE IF NOT EXISTS brain_nodes (
  id            TEXT PRIMARY KEY,
  session_hash  TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL,
  data          JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Live nodes are a few hundred rows out of tens of thousands; scheduling reads only those.
CREATE INDEX IF NOT EXISTS brain_nodes_live_idx ON brain_nodes (status) WHERE status IN ('idle', 'computing');

CREATE TABLE IF NOT EXISTS brain_jobs (
  id            TEXT PRIMARY KEY,
  -- A browser node id (brain_nodes) or a native Brain Node id (brain_documents, kind 'nnode').
  -- Not a foreign key: the two kinds of node live in different tables and both settle from here.
  assigned_to   TEXT NOT NULL,
  status        TEXT NOT NULL,
  submitted_at  BIGINT NOT NULL,
  -- Contains secret verification material (sample indices, canary expectations).
  -- Never expose this column through a read API.
  data          JSONB NOT NULL
);
-- Until 2026-10-07 assigned_to referenced brain_nodes(id), which silently rejected every native
-- node's work record (the insert failed inside a deferred callback and was only logged), so no
-- native GPU could ever enter settlement.
ALTER TABLE brain_jobs DROP CONSTRAINT IF EXISTS brain_jobs_assigned_to_fkey;
CREATE INDEX IF NOT EXISTS brain_jobs_recent ON brain_jobs (submitted_at DESC);
CREATE INDEX IF NOT EXISTS brain_jobs_pending ON brain_jobs (assigned_to) WHERE status = 'assigned';
-- Per-node history (node pages, reputation): without this every lookup walked the recent index.
CREATE INDEX IF NOT EXISTS brain_jobs_by_node ON brain_jobs (assigned_to, submitted_at DESC);

CREATE TABLE IF NOT EXISTS brain_challenges (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reward ledger. Amounts are lamports. Written only by services/settlement.ts and services/claims.ts.
CREATE TABLE IF NOT EXISTS brain_reward_epochs (
  id         TEXT PRIMARY KEY,
  starts_at  BIGINT NOT NULL,
  provenance TEXT NOT NULL,
  data       JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS brain_reward_epochs_recent ON brain_reward_epochs (starts_at DESC);

CREATE TABLE IF NOT EXISTS brain_reward_allocations (
  epoch_id   TEXT NOT NULL REFERENCES brain_reward_epochs(id),
  wallet     TEXT NOT NULL,
  lamports   BIGINT NOT NULL CHECK (lamports >= 0),
  data       JSONB NOT NULL,
  PRIMARY KEY (epoch_id, wallet)
);
CREATE INDEX IF NOT EXISTS brain_reward_allocations_wallet ON brain_reward_allocations (wallet);

CREATE TABLE IF NOT EXISTS brain_reward_claims (
  id         TEXT PRIMARY KEY,           -- the signed single-use nonce: replays fail on this key
  wallet     TEXT NOT NULL,
  lamports   BIGINT NOT NULL CHECK (lamports > 0),
  status     TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  data       JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS brain_reward_claims_wallet ON brain_reward_claims (wallet);
-- At most one in-flight claim per wallet: concurrent claim requests cannot double-spend a balance.
CREATE UNIQUE INDEX IF NOT EXISTS brain_reward_claims_one_pending ON brain_reward_claims (wallet) WHERE status = 'pending';

-- Distributed jobs: one request split into work units across real nodes. Units live in brain_jobs (data.parentId).
CREATE TABLE IF NOT EXISTS brain_distributed_jobs (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  data       JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS brain_distributed_jobs_recent ON brain_distributed_jobs (created_at DESC);

-- Economic layer documents: receipts, accounting events, orders, route decisions, customers,
-- api keys (key = sha256 of the secret), customer request records (key = customer id), treasury,
-- v2 reward epochs, metric samples. `at` orders listings; `key` is the secondary index.
CREATE TABLE IF NOT EXISTS brain_documents (
  kind TEXT NOT NULL,
  id   TEXT NOT NULL,
  key  TEXT,
  at   BIGINT NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS brain_documents_recent ON brain_documents (kind, at DESC);
CREATE INDEX IF NOT EXISTS brain_documents_key ON brain_documents (kind, key);
-- Keyed listings are always "newest first with a limit"; let the index deliver that order.
CREATE INDEX IF NOT EXISTS brain_documents_key_recent ON brain_documents (kind, key, at DESC);
