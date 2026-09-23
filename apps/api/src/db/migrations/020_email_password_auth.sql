-- Phase 16/H — email + password as a third application-identity provider,
-- alongside migration 011's GitHub and migration 014's Google. 'EMAIL' joins
-- the same auth_provider enum those introduced (ALTER TYPE ADD VALUE, same
-- pattern as 003/004's enum-value additions) rather than a parallel enum —
-- it's still just "which provider created this account."
--
-- This is its OWN migration file, separate from 021's column/index changes
-- that actually reference the 'EMAIL' value: Postgres does not allow a
-- newly-added enum value to be USED (e.g. in a WHERE clause) within the same
-- transaction that added it, and this project's migration runner executes
-- each file as one implicit transaction (see db/migrate.ts).

ALTER TYPE auth_provider ADD VALUE IF NOT EXISTS 'EMAIL';
