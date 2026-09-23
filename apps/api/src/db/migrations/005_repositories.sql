-- Phase 1 — Repository Feature: public repository connection + metadata
-- only. No cloning/indexing/credentials — see the Repository Feature Audit.
-- Follows the same enum/table/index conventions as 001_scans.sql and
-- 002_components.sql.

DO $$ BEGIN
  CREATE TYPE repository_provider AS ENUM ('GITHUB', 'GITLAB', 'BITBUCKET');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE repository_status AS ENUM ('CONNECTED', 'DISCONNECTED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS repositories (
  id UUID PRIMARY KEY,
  -- Best-effort, client-supplied identifier — matches component_jobs.owner_id
  -- and scans.owner_id. This project has no real authentication system (see
  -- the Repository Feature Audit); this is not a security boundary.
  owner_id TEXT,
  repo_url TEXT NOT NULL,
  provider repository_provider NOT NULL,
  branch TEXT NOT NULL,
  status repository_status NOT NULL DEFAULT 'CONNECTED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One connection per (owner, normalized repo URL, branch) — the same
  -- public repo can be connected once per branch, and re-adding the exact
  -- same repo+branch for the same owner is a no-op conflict rather than a
  -- duplicate row. owner_id can be NULL (no real auth yet), so this alone
  -- cannot fully prevent duplicates across anonymous callers — acceptable
  -- for Phase 1 metadata-only storage, revisited once real auth exists.
  CONSTRAINT uq_repositories_owner_url_branch UNIQUE (owner_id, repo_url, branch)
);

CREATE INDEX IF NOT EXISTS idx_repositories_owner_id ON repositories(owner_id);
CREATE INDEX IF NOT EXISTS idx_repositories_created_at ON repositories(created_at DESC);
