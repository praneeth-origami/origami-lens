-- Phase 3 — Repository Feature: Tree-sitter/AST indexing + deterministic
-- code chunking. No embeddings/pgvector columns — see the Repository
-- Feature Audit. Does not modify 001_scans.sql .. 006_repository_clone_jobs.sql;
-- extends the repository_status enum from 005 with two more values, the
-- same additive pattern 006 already used for CLONING/READY_FOR_INDEXING/FAILED.

DO $$ BEGIN
  CREATE TYPE repository_index_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE repository_index_file_status AS ENUM (
    'INDEXED', 'SKIPPED_BINARY', 'SKIPPED_UNSUPPORTED_LANGUAGE', 'SKIPPED_TOO_LARGE',
    'SKIPPED_IGNORED', 'SKIPPED_SENSITIVE', 'PARSE_ERROR'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ADD VALUE IF NOT EXISTS is already idempotent on its own (PG9.6+).
ALTER TYPE repository_status ADD VALUE IF NOT EXISTS 'INDEXING';
ALTER TYPE repository_status ADD VALUE IF NOT EXISTS 'READY_FOR_SEARCH';

CREATE TABLE IF NOT EXISTS repository_index_jobs (
  id UUID PRIMARY KEY,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  clone_job_id UUID NOT NULL REFERENCES repository_clone_jobs(id) ON DELETE CASCADE,
  -- Best-effort, client-supplied identifier — same non-authentication
  -- caveat as repositories.owner_id (see the Repository Feature Audit).
  owner_id TEXT,
  -- The exact clone commit this job indexes — every file/chunk row below is
  -- tied to this same commit_sha, so a later re-clone at a new commit
  -- produces an entirely separate index rather than mutating this one.
  commit_sha TEXT NOT NULL,
  status repository_index_status NOT NULL DEFAULT 'QUEUED',
  indexer_version TEXT NOT NULL DEFAULT '1',
  files_indexed INTEGER,
  files_skipped INTEGER,
  chunks_created INTEGER,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repository_index_jobs_repository_id ON repository_index_jobs(repository_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repository_index_jobs_commit_sha ON repository_index_jobs(commit_sha);
CREATE INDEX IF NOT EXISTS idx_repository_index_jobs_owner_id ON repository_index_jobs(owner_id);

CREATE TABLE IF NOT EXISTS repository_index_files (
  id UUID PRIMARY KEY,
  index_job_id UUID NOT NULL REFERENCES repository_index_jobs(id) ON DELETE CASCADE,
  -- Denormalized from the job row for convenient querying/indexing without a join.
  repository_id UUID NOT NULL,
  commit_sha TEXT NOT NULL,
  file_path TEXT NOT NULL,
  language TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL DEFAULT 0,
  -- NULL for files whose content was never read (sensitive/too-large/ignored).
  content_hash TEXT,
  status repository_index_file_status NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repository_index_files_index_job_id ON repository_index_files(index_job_id);
CREATE INDEX IF NOT EXISTS idx_repository_index_files_repository_id ON repository_index_files(repository_id);
CREATE INDEX IF NOT EXISTS idx_repository_index_files_file_path ON repository_index_files(file_path);
CREATE INDEX IF NOT EXISTS idx_repository_index_files_language ON repository_index_files(language);

CREATE TABLE IF NOT EXISTS repository_code_chunks (
  id UUID PRIMARY KEY,
  index_job_id UUID NOT NULL REFERENCES repository_index_jobs(id) ON DELETE CASCADE,
  repository_id UUID NOT NULL,
  commit_sha TEXT NOT NULL,
  file_id UUID NOT NULL REFERENCES repository_index_files(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  language TEXT NOT NULL,
  symbol TEXT NOT NULL,
  symbol_type TEXT NOT NULL,
  parent_symbol TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  is_exported BOOLEAN NOT NULL DEFAULT false,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  -- Deterministic logical identity (see repository-chunker.ts's
  -- computeChunkKey) — NOT this row's primary key. `id` above stays a
  -- random UUID like every other primary key in this schema; chunk_key is
  -- the separate, reproducible identity re-indexing the same commit yields.
  chunk_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repository_code_chunks_index_job_id ON repository_code_chunks(index_job_id);
CREATE INDEX IF NOT EXISTS idx_repository_code_chunks_repository_id ON repository_code_chunks(repository_id);
CREATE INDEX IF NOT EXISTS idx_repository_code_chunks_commit_sha ON repository_code_chunks(commit_sha);
CREATE INDEX IF NOT EXISTS idx_repository_code_chunks_file_path ON repository_code_chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_repository_code_chunks_language ON repository_code_chunks(language);
CREATE INDEX IF NOT EXISTS idx_repository_code_chunks_symbol ON repository_code_chunks(symbol);
CREATE INDEX IF NOT EXISTS idx_repository_code_chunks_content_hash ON repository_code_chunks(content_hash);
