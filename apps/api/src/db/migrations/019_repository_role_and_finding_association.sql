-- Separate frontend/backend repository support. Two independent, additive
-- changes — neither backfills or guesses at existing data (same deliberate
-- tradeoff as migration 018's organization_id additions):
--
--   1. repositories.role: which layer this repository represents. Every
--      existing repository (and every new one that doesn't specify a role)
--      defaults to FULL_STACK, which is exactly today's implicit behavior —
--      zero change for any current single-repository setup.
--
--   2. issues.repository_id: a scan finding has no inherent link to a
--      connected repository (see IssueDetailPage.tsx's own Phase 10 comment)
--      — the user picks one via the existing manual picker. This column lets
--      that choice be persisted once made, instead of re-picked from scratch
--      on every page load, and lets the fix-proposal route reject a later
--      attempt to redirect the SAME finding at a different repository
--      (REPOSITORY_MISMATCH) once a choice has been recorded. NULL means
--      "not yet resolved" — exactly today's state for every existing row.

DO $$ BEGIN
  CREATE TYPE repository_role AS ENUM ('FRONTEND', 'BACKEND', 'FULL_STACK');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE repositories ADD COLUMN IF NOT EXISTS role repository_role NOT NULL DEFAULT 'FULL_STACK';

ALTER TABLE issues ADD COLUMN IF NOT EXISTS repository_id UUID REFERENCES repositories(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_issues_repository_id ON issues(repository_id);
