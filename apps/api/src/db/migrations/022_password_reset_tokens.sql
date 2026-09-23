-- Phase 16/H — password-reset tokens. Only the token's hash is ever stored
-- (same defense-in-depth reasoning as a password itself, or a session id):
-- a leaked row can never be replayed as a working reset link. `used_at`
-- marks a token permanently spent (checked, never deleted, so a reused
-- token is a clean "already used" rather than an ambiguous "not found").

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_password_reset_tokens_hash ON password_reset_tokens(token_hash);
