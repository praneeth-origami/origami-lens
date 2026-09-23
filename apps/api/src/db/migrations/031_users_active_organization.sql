-- Which workspace is "active" for a user who now belongs to more than one
-- (previously every user had exactly one org, so this concept didn't exist).
-- Nullable and unused until a user switches workspaces or accepts a
-- workspace invitation (workspace-invitation-repository.ts sets it
-- automatically on accept) — every existing user is unaffected, index.ts's
-- resolveOrganizationIdForAuthenticatedRequest falls back to its prior
-- "first organization" behavior whenever this is null or stale.

ALTER TABLE users ADD COLUMN IF NOT EXISTS active_organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
