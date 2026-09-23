-- Phase 2 — Organizations, the real multi-tenancy foundation. Every user
-- gets exactly one personal organization: auto-created here for every
-- existing user (backfill below), and self-healed by
-- organization-repository.ts's getOrCreatePersonalOrganization on every
-- future login for any user this backfill somehow misses (e.g. a row
-- inserted between this migration running and the next deploy). A later,
-- non-personal organization (Team/Agency sharing) is the exact same shape —
-- just with personal_owner_user_id left NULL and more than one membership
-- row — so nothing about repositories.organization_id (migration 016) will
-- need to change again when that ships.

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  -- Non-null only for a user's own personal organization. UNIQUE guarantees
  -- exactly one personal org per user; NULL for a real team/agency org.
  personal_owner_user_id UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TYPE organization_role AS ENUM ('OWNER', 'MEMBER');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS organization_memberships (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role organization_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_organization_membership_org_user UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_organization_memberships_user_id ON organization_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_organization_memberships_organization_id ON organization_memberships(organization_id);

-- Backfill: every user that predates this migration (or that a race with a
-- concurrent deploy created before it ran) gets a personal organization.
-- Re-runnable: migrate.ts replays every migration file on every run (there
-- is no migration-tracking table), so this only ever inserts for a user
-- with no personal org yet.
INSERT INTO organizations (id, name, personal_owner_user_id)
SELECT gen_random_uuid(), COALESCE(u.display_name, u.primary_provider_login) || ' workspace', u.id
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.personal_owner_user_id = u.id);

INSERT INTO organization_memberships (id, organization_id, user_id, role)
SELECT gen_random_uuid(), o.id, o.personal_owner_user_id, 'OWNER'
FROM organizations o
WHERE o.personal_owner_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM organization_memberships m
    WHERE m.organization_id = o.id AND m.user_id = o.personal_owner_user_id
  );
