-- Phase 16/C — real, per-user Git provider authorization (GitHub App
-- installations first; GitLab/Bitbucket OAuth connections are a later
-- phase but share this same table/shape). Does not modify 001..012.
--
-- This table is the single place any actual provider credential-adjacent
-- data lives. For GitHub (Phase C), only `installation_id` is stored — a
-- non-secret integer identifying which GitHub App installation this
-- connection represents; the actual push/API token is NEVER stored here or
-- anywhere else. It is minted fresh, in-memory only, from
-- GITHUB_APP_PRIVATE_KEY + installation_id on every use and discarded
-- immediately after (see github-app-auth.ts) — GitHub's own installation
-- tokens already expire in ~1 hour, so persisting one would only add a
-- leak surface for no benefit.
--
-- `encrypted_access_token`/`encrypted_refresh_token`/`token_expires_at`
-- exist now for GitLab/Bitbucket OAuth (a later phase) — they stay NULL
-- for every GitHub row created by this phase's code.

DO $$ BEGIN
  CREATE TYPE provider_connection_status AS ENUM ('ACTIVE', 'REVOKED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS provider_connections (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider repository_provider NOT NULL,
  -- Display-only (e.g. the GitHub org/user login the installation is
  -- under) — never used as an authorization key.
  external_account_login TEXT NOT NULL,
  -- GitHub App installation id. NULL for non-GitHub providers (a later
  -- phase's OAuth-based connections have no installation concept).
  installation_id BIGINT,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  status provider_connection_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One connection row per installation — re-installing/reconnecting the
  -- same installation updates who it belongs to rather than duplicating.
  CONSTRAINT uq_provider_connections_installation UNIQUE (provider, installation_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_connections_user_id ON provider_connections(user_id);
