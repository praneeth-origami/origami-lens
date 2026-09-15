-- Phase 2 — Repository Feature: clone + discovery job state only. No
-- Tree-sitter/AST/indexing/embeddings — see the Repository Feature Audit.
-- Does not modify 001_scans.sql .. 005_repositories.sql; extends the
-- repository_status enum from 005 with three new values (safe: adding an
-- enum value is additive and does not affect existing CONNECTED/DISCONNECTED
-- rows or code that only checked for those two).

DO $$ BEGIN
  CREATE TYPE repository_clone_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ADD VALUE IF NOT EXISTS is already idempotent on its own (PG9.6+), so no
-- duplicate_object guard is needed here the way CREATE TYPE above needs one.
ALTER TYPE repository_status ADD VALUE IF NOT EXISTS 'CLONING';
ALTER TYPE repository_status ADD VALUE IF NOT EXISTS 'READY_FOR_INDEXING';
ALTER TYPE repository_status ADD VALUE IF NOT EXISTS 'FAILED';

CREATE TABLE IF NOT EXISTS repository_clone_jobs (
  id UUID PRIMARY KEY,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  -- Best-effort, client-supplied identifier — same non-authentication
  -- caveat as repositories.owner_id (see the Repository Feature Audit).
  owner_id TEXT,
  status repository_clone_status NOT NULL DEFAULT 'QUEUED',
  -- Filesystem location of the clone, generated from trusted internal IDs
  -- only (repository id + job id) — never derived from repo/branch names.
  clone_path TEXT,
  commit_sha TEXT,
  discovered_file_count INTEGER,
  discovered_directory_count INTEGER,
  discovered_total_size_bytes BIGINT,
  -- Full RepositoryDiscoveryMetadata (extensions map, top-level dirs/files,
  -- largest files) — the scalar columns above duplicate its three headline
  -- numbers for cheap querying/sorting without parsing JSON.
  discovery_json JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repository_clone_jobs_repository_id ON repository_clone_jobs(repository_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repository_clone_jobs_owner_id ON repository_clone_jobs(owner_id);
