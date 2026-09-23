-- Phase 8 — Repository Issue Detection + AI Fix Proposal + Reviewable Diff.
-- Does not modify 001_scans.sql .. 008_repository_embeddings.sql. Adds three
-- new tables only: repository_issues, repository_issue_analyses,
-- repository_fix_proposals. No repository_status enum change is needed —
-- an issue's own lifecycle is entirely independent of the repository's own
-- clone/index/embed status machine from migrations 005-008.

DO $$ BEGIN
  CREATE TYPE repository_issue_severity AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE repository_issue_status AS ENUM ('OPEN', 'ANALYZING', 'ANALYZED', 'FIX_PROPOSED', 'APPROVED', 'REJECTED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE repository_issue_source AS ENUM ('USER_REPORTED', 'AI_DETECTED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS repository_issues (
  id UUID PRIMARY KEY,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  -- Best-effort, client-supplied identifier — same non-authentication
  -- caveat as repositories.owner_id (see the Repository Feature Audit).
  owner_id TEXT,
  -- The repository's indexed commit at the moment this issue was filed —
  -- set server-side from the latest completed index job, never client-
  -- supplied. Fix proposals later re-check this against the repository's
  -- CURRENT indexed commit so a re-index between issue creation and fix
  -- proposal can never silently target stale evidence.
  commit_sha TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity repository_issue_severity NOT NULL DEFAULT 'MEDIUM',
  status repository_issue_status NOT NULL DEFAULT 'OPEN',
  source repository_issue_source NOT NULL DEFAULT 'USER_REPORTED',
  -- Nullable: a repository-wide issue has no single file/symbol/line range.
  file_path TEXT,
  symbol TEXT,
  line_start INTEGER,
  line_end INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repository_issues_repository_id ON repository_issues(repository_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repository_issues_commit_sha ON repository_issues(commit_sha);
CREATE INDEX IF NOT EXISTS idx_repository_issues_status ON repository_issues(status);
CREATE INDEX IF NOT EXISTS idx_repository_issues_owner_id ON repository_issues(owner_id);

DO $$ BEGIN
  CREATE TYPE repository_issue_analysis_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE repository_issue_confidence AS ENUM ('LOW', 'MEDIUM', 'HIGH');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS repository_issue_analyses (
  id UUID PRIMARY KEY,
  issue_id UUID NOT NULL REFERENCES repository_issues(id) ON DELETE CASCADE,
  -- Denormalized from the issue for convenient querying/indexing without a join.
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  status repository_issue_analysis_status NOT NULL DEFAULT 'QUEUED',
  summary TEXT,
  root_cause TEXT,
  confidence repository_issue_confidence,
  -- string[] each — stored as JSONB rather than a separate join table, same
  -- proportionate-complexity judgment as repository_clone_jobs.discovery_json.
  affected_files JSONB,
  affected_symbols JSONB,
  reasoning TEXT,
  recommended_fix TEXT,
  validation_plan TEXT,
  -- The model that actually produced this analysis — never assumed ahead of
  -- a real call (see repository-issue-analysis-provider.ts), same
  -- discipline as repository_embedding_jobs.model.
  model TEXT,
  evidence_chunk_count INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repository_issue_analyses_issue_id ON repository_issue_analyses(issue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repository_issue_analyses_repository_id ON repository_issue_analyses(repository_id);
CREATE INDEX IF NOT EXISTS idx_repository_issue_analyses_commit_sha ON repository_issue_analyses(commit_sha);
CREATE INDEX IF NOT EXISTS idx_repository_issue_analyses_status ON repository_issue_analyses(status);

-- Duplicate-job protection as a real database constraint, not only a
-- route-level check (see the Phase 8 report) — at most one QUEUED/RUNNING
-- analysis may exist per issue at a time. A plain UNIQUE constraint on
-- issue_id would forbid ever re-analyzing an issue after the first run
-- completes; a partial unique index scoped to only the "active" statuses
-- allows unlimited COMPLETED/FAILED/CANCELLED history while still
-- preventing two concurrent analysis jobs for the same issue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_repository_issue_analyses_active
  ON repository_issue_analyses (issue_id)
  WHERE status IN ('QUEUED', 'RUNNING');

DO $$ BEGIN
  CREATE TYPE repository_fix_proposal_status AS ENUM ('QUEUED', 'RUNNING', 'FIX_PROPOSED', 'APPROVED', 'REJECTED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS repository_fix_proposals (
  id UUID PRIMARY KEY,
  issue_id UUID NOT NULL REFERENCES repository_issues(id) ON DELETE CASCADE,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  -- The commit this proposal was validated against — re-checked at
  -- propose-fix time against the repository's CURRENT indexed commit (see
  -- repository-fix-service.ts); never trusted from AI output.
  commit_sha TEXT NOT NULL,
  status repository_fix_proposal_status NOT NULL DEFAULT 'QUEUED',
  summary TEXT,
  -- RepositoryFixFileChange[] — see packages/contracts. Never contains raw
  -- vectors/embeddings/secrets; every field is either AI-authored diff text
  -- or a server-computed hash of already-indexed (non-sensitive) content.
  files_changed JSONB NOT NULL DEFAULT '[]',
  proposed_diff TEXT NOT NULL DEFAULT '',
  model TEXT,
  -- Present only when status = FAILED — see RepositoryFixProposal.validationError.
  validation_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repository_fix_proposals_issue_id ON repository_fix_proposals(issue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repository_fix_proposals_repository_id ON repository_fix_proposals(repository_id);
CREATE INDEX IF NOT EXISTS idx_repository_fix_proposals_commit_sha ON repository_fix_proposals(commit_sha);
CREATE INDEX IF NOT EXISTS idx_repository_fix_proposals_status ON repository_fix_proposals(status);

-- Same partial-unique-index pattern as analyses above: at most one "active"
-- (not yet APPROVED/REJECTED/FAILED) proposal may exist per issue. A new
-- propose-fix call while one is already QUEUED/RUNNING/FIX_PROPOSED is
-- rejected rather than creating a second, competing proposal to review.
CREATE UNIQUE INDEX IF NOT EXISTS uq_repository_fix_proposals_active
  ON repository_fix_proposals (issue_id)
  WHERE status IN ('QUEUED', 'RUNNING', 'FIX_PROPOSED');
