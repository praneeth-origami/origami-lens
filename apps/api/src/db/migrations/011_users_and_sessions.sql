-- Phase 16/A — Real application user identity + server-side sessions.
-- Does not modify 001_scans.sql .. 010_repository_fix_workflows.sql. This is
-- purely additive: the existing `owner_id TEXT` columns on repositories and
-- repository_fix_workflows are untouched here (see the Phase 16 design
-- report's migration-strategy section — a later migration adds a nullable
-- `user_id UUID` alongside them once route-level authorization actually
-- switches over, which is Phase B, not this one).
--
-- Reuses the existing `repository_provider` enum (GITHUB/GITLAB/BITBUCKET,
-- defined in 005_repositories.sql) for `users.primary_provider` instead of
-- introducing a parallel enum — the set of supported login providers is the
-- same set of supported Git providers.
--
-- No provider credentials of any kind live in either table below — a
-- session row is only ever a random opaque id + which user it belongs to.
-- Provider authorization tokens (GitHub App installation, GitLab/Bitbucket
-- OAuth tokens) are explicitly out of scope for this migration — see Phase C
-- in the Phase 16 design report.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  -- The OAuth provider that created this account, and that provider's
  -- stable numeric/string account id — NOT a username (GitHub logins can be
  -- renamed; the account id cannot), which is why github_login is stored
  -- separately below as a display-only field.
  primary_provider repository_provider NOT NULL,
  primary_provider_account_id TEXT NOT NULL,
  primary_provider_login TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One Origami Lens account per external provider account — prevents the
  -- same GitHub user from ever silently becoming two different users here.
  CONSTRAINT uq_users_provider_account UNIQUE (primary_provider, primary_provider_account_id)
);

-- Sessions are the authenticated-request boundary: server-side rows, not
-- stateless JWTs, specifically so logout/revocation is a real DELETE rather
-- than requiring a token blocklist (see the Phase 16 design report's
-- authenticated-request-model + threat-model sections). `id` is the opaque,
-- high-entropy (UUID v4, 122 bits) value carried in the session cookie —
-- knowing it is the only way to use the session, and it is never logged or
-- returned in any API response body.
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
