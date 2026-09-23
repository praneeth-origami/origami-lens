-- Report sharing — mirrors password_reset_tokens/email_verification_tokens
-- exactly: only the token's hash is ever stored, never the raw value. A scan
-- IS the report (no separate `reports` table exists or is needed) — this is
-- just the join between a scan and a public, revocable share token.
-- POST /scans/:scanId/report/share always ROTATES (revokes any existing
-- active row for that scan, inserts a fresh one) rather than trying to
-- redisplay a previously issued raw token, which is never recoverable from
-- a hash — see report-share-service.ts.

CREATE TABLE IF NOT EXISTS report_share_links (
  id UUID PRIMARY KEY,
  scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_report_share_links_scan_id ON report_share_links(scan_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_share_links_token_hash ON report_share_links(token_hash);
