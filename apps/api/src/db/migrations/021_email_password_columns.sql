-- Continuation of 020 (split into its own transaction/file — see 020's
-- comment for why). password_hash is nullable because it's only ever set
-- for EMAIL-provider accounts; a GitHub/Google account never has one. Never
-- selected into AuthUser (see rowToUser in db/user-repository.ts) — only
-- read internally by password-auth-service.ts's login/reset verification.
--
-- The partial unique index is scoped to primary_provider = 'EMAIL' only —
-- deliberately NOT `WHERE email IS NOT NULL`. Real seeded/test OAuth data
-- already has multiple GitHub accounts sharing a placeholder email (e.g.
-- octocat@example.com), which is harmless today since OAuth accounts are
-- keyed by (primary_provider, primary_provider_account_id), never by email —
-- a plain `WHERE email IS NOT NULL` index would fail to even create against
-- that real data. Only EMAIL-provider accounts actually authenticate BY
-- email, so that's the only case that needs email to be a unique identifier.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_provider ON users (email) WHERE primary_provider = 'EMAIL';
