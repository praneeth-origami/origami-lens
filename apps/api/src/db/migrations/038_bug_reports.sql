-- Create Bug Report — a self-contained incident record captured from the
-- extension on the real page the user was viewing (never a dashboard/scan
-- URL). Distinct from a scan Issue: it can exist standalone, or reference
-- one (linked_issue_id/linked_scan_id) to reuse that issue's own
-- problem/cause/suggestedFix rather than regenerating them. Console/network
-- entries are stored as JSONB (same shape as BrowserEvidence's own
-- ConsoleEntry/NetworkEntry) — already privacy-scrubbed before this INSERT,
-- same posture as scans.full_evidence_json (migration 036).

CREATE TABLE IF NOT EXISTS bug_reports (
  id UUID PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  page_title TEXT,
  browser TEXT NOT NULL,
  operating_system TEXT NOT NULL,
  viewport_width INTEGER NOT NULL,
  viewport_height INTEGER NOT NULL,
  device_pixel_ratio REAL NOT NULL DEFAULT 1,
  has_screenshot BOOLEAN NOT NULL DEFAULT FALSE,
  console_errors_json JSONB NOT NULL DEFAULT '[]',
  network_errors_json JSONB NOT NULL DEFAULT '[]',
  dom_evidence_json JSONB,
  description TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  reproduction_steps_json JSONB NOT NULL DEFAULT '[]',
  expected_behavior TEXT,
  actual_behavior TEXT,
  suggested_fix TEXT,
  linked_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  linked_scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_organization_id ON bug_reports(organization_id);
CREATE INDEX IF NOT EXISTS idx_bug_reports_created_at ON bug_reports(created_at DESC);
