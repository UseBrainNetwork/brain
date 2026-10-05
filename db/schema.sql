-- BRAIN network store. Postgres 14+ (or any Postgres-compatible: Neon, Supabase, CockroachDB*).
-- Documents are stored as JSONB with the columns we query on lifted out and indexed.

CREATE SEQUENCE IF NOT EXISTS brain_job_seq START 5000001;

CREATE TABLE IF NOT EXISTS brain_nodes (
  id            TEXT PRIMARY KEY,
  session_hash  TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL,
  data          JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brain_jobs (
  id            TEXT PRIMARY KEY,
  assigned_to   TEXT NOT NULL REFERENCES brain_nodes(id),
  status        TEXT NOT NULL,
  submitted_at  BIGINT NOT NULL,
  -- Contains secret verification material (sample indices, canary expectations).
  -- Never expose this column through a read API.
  data          JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS brain_jobs_recent ON brain_jobs (submitted_at DESC);
CREATE INDEX IF NOT EXISTS brain_jobs_pending ON brain_jobs (assigned_to) WHERE status = 'assigned';

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
