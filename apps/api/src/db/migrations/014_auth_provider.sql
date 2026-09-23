-- Phase 16/G — Google as a real, standalone login provider.
--
-- Migration 011 deliberately reused the `repository_provider` enum
-- (GITHUB/GITLAB/BITBUCKET) for `users.primary_provider`, on the stated
-- reasoning that "the set of supported login providers is the same set of
-- supported Git providers." That reasoning no longer holds: Google can
-- authenticate a human but can never host a repository, so it must never be
-- a legal value anywhere `repository_provider` is used (provider_connections,
-- repositories.provider, the git-provider-client switch statements). Reusing
-- the same enum for both concepts would force GOOGLE to become a value every
-- one of those git-provider code paths would then have to defensively reject.
--
-- Introduces a separate `auth_provider` enum (a superset: every existing
-- repository_provider value, plus GOOGLE) scoped ONLY to `users.primary_provider`,
-- and migrates that one column to it. No other table changes. Existing rows'
-- values (all GITHUB today) carry over unchanged via the text-cast USING clause.

DO $$ BEGIN
  CREATE TYPE auth_provider AS ENUM ('GITHUB', 'GITLAB', 'BITBUCKET', 'GOOGLE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE users ALTER COLUMN primary_provider TYPE auth_provider USING primary_provider::text::auth_provider;
