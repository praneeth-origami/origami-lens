-- UX audit follow-up — scans and component-generation jobs get the same
-- real per-organization ownership boundary repositories already have
-- (migration 016). Unlike repositories, there is no `user_id` column to
-- backfill from here: `scans.owner_id`/`component_jobs.owner_id` have
-- always been unauthenticated, client-supplied text (see 005_repositories.sql's
-- identical caveat about the old `owner_id` column) — there is no reliable
-- way to know which real, authenticated user actually ran a pre-existing
-- scan or generated a pre-existing component. Existing rows therefore get
-- organization_id = NULL and become inaccessible through any now-scoped
-- route, exactly the same deliberate tradeoff migration 012 already made
-- for pre-Phase-16 repositories.

ALTER TABLE scans ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_scans_organization_id ON scans(organization_id);

ALTER TABLE component_jobs ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_component_jobs_organization_id ON component_jobs(organization_id);
