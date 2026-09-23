-- Phase 2 — repositories move from per-user ownership to per-organization
-- ownership, the real foundation for Team/Agency sharing (see 015's
-- comment). `user_id` (migration 012) is left in place, untouched, as a
-- "created by" audit field only — no authorization code reads it after this
-- migration; `organization_id` is the only value any ownership/access check
-- compares against. Every user currently has exactly one (personal)
-- organization, so backfilling from user_id -> that user's personal org is
-- unambiguous; nobody has a shared/team organization yet.

ALTER TABLE repositories ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

UPDATE repositories r
SET organization_id = o.id
FROM organizations o
WHERE o.personal_owner_user_id = r.user_id
  AND r.organization_id IS NULL
  AND r.user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_repositories_organization_id ON repositories(organization_id);

DO $$ BEGIN
  ALTER TABLE repositories ADD CONSTRAINT uq_repositories_org_url_branch UNIQUE (organization_id, repo_url, branch);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;
