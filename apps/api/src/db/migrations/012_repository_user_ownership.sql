-- Phase 16/B — Real repository ownership. Does not modify 001..011.
--
-- The existing `owner_id TEXT` column (005_repositories.sql) was always a
-- client-supplied, unauthenticated string — explicitly documented as "not a
-- security boundary." It is left in place, untouched, as inert legacy data:
-- no code reads it for authorization decisions after this migration. A new
-- `user_id UUID` column, backed by a real foreign key to the `users` table
-- (migration 011), becomes the ONLY value any ownership check compares
-- against, and it is only ever populated from an authenticated
-- request.user.id — never from client input.
--
-- Existing rows get `user_id = NULL` (there is no safe way to guess which
-- authenticated user, if any, a pre-Phase-A owner_id string corresponds to
-- — see the Phase 16 design report's migration-strategy section). A row
-- with `user_id IS NULL` is not owned by anyone and is therefore
-- inaccessible through any now-authenticated repository route — a known,
-- deliberate tradeoff, not a bug.
--
-- ON DELETE SET NULL (not CASCADE): deleting a user's account must not
-- silently destroy their repository/scan history — it becomes unowned
-- (inaccessible) rather than deleted, matching the same reasoning as the
-- NULL-for-pre-auth-rows case above.

ALTER TABLE repositories ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_repositories_user_id ON repositories(user_id);

-- The original uq_repositories_owner_url_branch (005_repositories.sql) is
-- now toothless for new rows: every row created after Phase 16/B has
-- owner_id = NULL forever, and Postgres never treats two NULLs as equal for
-- a UNIQUE constraint, so it would silently permit unlimited duplicate
-- (repo_url, branch) rows across different users. This new constraint on
-- (user_id, repo_url, branch) is the real duplicate-prevention boundary
-- going forward — left additive rather than replacing the old constraint,
-- since dropping it would require touching a migration that may already be
-- applied in some environments.
DO $$ BEGIN
  ALTER TABLE repositories ADD CONSTRAINT uq_repositories_user_url_branch UNIQUE (user_id, repo_url, branch);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null;
END $$;
