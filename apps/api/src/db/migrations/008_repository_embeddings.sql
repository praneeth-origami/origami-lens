-- Phase 4 — Repository Feature: BGE-M3 embeddings + pgvector. Does not
-- modify 001_scans.sql .. 007_repository_index.sql; extends the
-- repository_status enum from 005 with two more values, the same additive
-- pattern 006/007 already used.

-- Requires the pgvector/pgvector:pg16 image (see docker-compose.yml) —
-- postgres:16-alpine does not ship this extension.
CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE repository_embedding_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ADD VALUE IF NOT EXISTS is already idempotent on its own (PG9.6+).
ALTER TYPE repository_status ADD VALUE IF NOT EXISTS 'EMBEDDING';
ALTER TYPE repository_status ADD VALUE IF NOT EXISTS 'EMBEDDINGS_READY';

CREATE TABLE IF NOT EXISTS repository_embedding_jobs (
  id UUID PRIMARY KEY,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  index_job_id UUID NOT NULL REFERENCES repository_index_jobs(id) ON DELETE CASCADE,
  -- Best-effort, client-supplied identifier — same non-authentication
  -- caveat as repositories.owner_id (see the Repository Feature Audit).
  owner_id TEXT,
  -- The exact index-job commit these embeddings are for — every embedding
  -- row below is tied to this same commit_sha.
  commit_sha TEXT NOT NULL,
  status repository_embedding_status NOT NULL DEFAULT 'QUEUED',
  -- The actual model/dimensions used — never assumed ahead of a real call
  -- (see repository-embedding-provider.ts). model is set at job creation
  -- from server config; dimensions is filled in once the first embedding
  -- call actually succeeds.
  model TEXT NOT NULL,
  dimensions INTEGER,
  total_chunks INTEGER,
  embedded_chunks INTEGER,
  skipped_chunks INTEGER,
  failed_chunks INTEGER,
  error TEXT,
  error_category TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repository_embedding_jobs_repository_id ON repository_embedding_jobs(repository_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repository_embedding_jobs_commit_sha ON repository_embedding_jobs(commit_sha);
CREATE INDEX IF NOT EXISTS idx_repository_embedding_jobs_owner_id ON repository_embedding_jobs(owner_id);

-- A separate table from repository_code_chunks (never vector columns bolted
-- directly onto that Phase 3 table) — one row per successfully embedded
-- chunk. A chunk that was skipped (too large for the configured
-- AI_EMBED_MAX_INPUT_TOKENS budget) or failed never gets a row here; those
-- are tracked only as aggregate counts on the owning job above.
--
-- vector(1024): BGE-M3's embedding dimension is intrinsic to the model
-- (not configurable), and independently verified against a real local
-- BGE-M3 instance during development (see the Phase 4 report's live
-- verification section) before this column type was chosen — never guessed.
-- The `dimensions` column is stored redundantly alongside the vector for
-- fast validation/auditing without needing to inspect the vector itself,
-- and the application layer (repository-embedding-worker.ts) independently
-- validates every returned vector's actual length against this fixed
-- dimension before ever attempting to insert — a mismatch is rejected, not
-- truncated or padded.
CREATE TABLE IF NOT EXISTS repository_code_embeddings (
  id UUID PRIMARY KEY,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  embedding_job_id UUID NOT NULL REFERENCES repository_embedding_jobs(id) ON DELETE CASCADE,
  -- Informational: which chunk row this embedding was computed from. Not
  -- part of the reuse/idempotency identity below — a re-index of the same
  -- commit produces brand-new repository_code_chunks rows (fresh UUIDs)
  -- even for byte-identical content, so content_hash (not chunk_id) is
  -- what actually identifies "the same logical chunk" across index runs.
  chunk_id UUID NOT NULL REFERENCES repository_code_chunks(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  embedding vector(1024) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The actual identity an embedding is valid for (see the Phase 4 report):
  -- repository + commit + exact content + model. Enforced as a real
  -- database constraint, not only an application-level check, so a retried
  -- or concurrently-running job can never insert a duplicate.
  CONSTRAINT uq_repository_code_embeddings_identity UNIQUE (repository_id, commit_sha, content_hash, model)
);

CREATE INDEX IF NOT EXISTS idx_repository_code_embeddings_repository_id ON repository_code_embeddings(repository_id);
CREATE INDEX IF NOT EXISTS idx_repository_code_embeddings_commit_sha ON repository_code_embeddings(commit_sha);
CREATE INDEX IF NOT EXISTS idx_repository_code_embeddings_chunk_id ON repository_code_embeddings(chunk_id);
CREATE INDEX IF NOT EXISTS idx_repository_code_embeddings_content_hash ON repository_code_embeddings(content_hash);
CREATE INDEX IF NOT EXISTS idx_repository_code_embeddings_embedding_job_id ON repository_code_embeddings(embedding_job_id);

-- No ANN index (ivfflat/hnsw) yet — deliberate. Both require a representative
-- amount of data to tune well (ivfflat's `lists` parameter in particular
-- degrades badly when built on a near-empty table), and this phase does not
-- implement search at all (Phase 5). An exact-search-only setup (relying on
-- the btree indexes above for repository/commit/model scoping, with any
-- future similarity comparison done as a plain sequential scan within that
-- already-narrow scope) is the safe, honest choice for development-sized
-- datasets. Revisit once Phase 5 introduces real query patterns and a
-- realistic embedded-chunk count to tune against.
