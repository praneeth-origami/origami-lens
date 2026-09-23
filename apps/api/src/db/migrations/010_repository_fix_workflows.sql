-- Phase 12 — Git Branch + Commit + Pull Request Workflow.
-- Does not modify 001_scans.sql .. 009_repository_issues.sql. The spec's
-- suggested filename ("009_repository_fix_pr.sql") collides with migration
-- 009, which Phase 8 already claimed for repository_issues/analyses/fix
-- proposals — this is therefore 010, the next free number, not a rename of
-- anything existing (see the Phase 12 report's numbering-conflict note).
--
-- One table, not two: Phase 11's "application" (a reviewable, retained
-- workspace) and Phase 12's "PR workflow" (branch/commit/push/PR) are 1:1
-- for the lifetime of a single applicationId — a fix is reviewed once and
-- either approved into exactly one branch/commit/PR attempt or left to
-- expire, never split across multiple concurrently-tracked PR attempts per
-- application. Merging them into repository_fix_workflows avoids an
-- unnecessary join for every read/write this phase performs, while still
-- covering every field the spec's two suggested tables listed.

DO $$ BEGIN
  CREATE TYPE repository_fix_workflow_status AS ENUM (
    'REVIEWABLE', 'APPROVED', 'BRANCH_CREATED', 'COMMITTED', 'PUSHED', 'PR_OPENED',
    'FAILED', 'CANCELLED', 'EXPIRED'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE repository_fix_syntax_status AS ENUM ('VALID', 'INVALID', 'UNSUPPORTED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE repository_fix_pr_provider AS ENUM ('GITHUB', 'GITLAB', 'BITBUCKET');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS repository_fix_workflows (
  -- Same value as Phase 11's applicationId — the isolated workspace on disk
  -- is addressed only by (repository_id, id), both trusted UUIDs (see
  -- repository-fix-worktree.ts's resolveFixWorkspaceDir), never by a
  -- client-supplied path.
  id UUID PRIMARY KEY,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  -- The website-scan finding id (Issue.id) — TEXT, not UUID: matches
  -- Phase 10's own finding_id typing (Issue ids are not guaranteed to be
  -- UUIDs in the legacy scan store).
  finding_id TEXT NOT NULL,
  owner_id TEXT,
  -- The ORIGINAL, unmodified commit the review/diff was computed from —
  -- never the new commit created on the fix branch (see new_commit_sha).
  commit_sha TEXT NOT NULL,
  -- sha256 of the canonical (stably key-ordered) proposal JSON that was
  -- reviewed — /approve must re-supply the identical proposal, verified by
  -- comparing this hash, so a client cannot swap in a different change set
  -- between review and approval.
  proposal_hash TEXT NOT NULL,
  changed_files JSONB NOT NULL DEFAULT '[]',
  diff TEXT NOT NULL DEFAULT '',
  line_grounding JSONB NOT NULL DEFAULT '[]',
  syntax_status repository_fix_syntax_status NOT NULL,
  -- Absolute path to the retained isolated workspace — re-validated via
  -- isPathInside(REPOSITORY_FIX_WORKSPACE_ROOT, ...) before ever being used
  -- again, never trusted blindly from this column alone.
  workspace_dir TEXT NOT NULL,
  status repository_fix_workflow_status NOT NULL DEFAULT 'REVIEWABLE',
  branch_name TEXT,
  -- The NEW commit created on the fix branch once approved — distinct from commit_sha above.
  new_commit_sha TEXT,
  provider repository_fix_pr_provider,
  pr_number INTEGER,
  pr_url TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The retained workspace (and this row's ability to be approved) expires
  -- after this — see REPOSITORY_FIX_WORKSPACE_TTL_MS. A cleanup pass
  -- transitions any still-REVIEWABLE row past this timestamp to EXPIRED and
  -- discards its workspace.
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repository_fix_workflows_repository_id ON repository_fix_workflows(repository_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repository_fix_workflows_finding_id ON repository_fix_workflows(finding_id);
CREATE INDEX IF NOT EXISTS idx_repository_fix_workflows_status ON repository_fix_workflows(status);
CREATE INDEX IF NOT EXISTS idx_repository_fix_workflows_expires_at ON repository_fix_workflows(expires_at) WHERE status = 'REVIEWABLE';

-- No credentials of any kind are ever stored in this table — see the
-- Phase 12 report's authentication-design section: GITHUB_TOKEN is a
-- server-side environment variable only.
