DO $$ BEGIN
  CREATE TYPE scan_type AS ENUM ('CURRENT_PAGE', 'WEBSITE', 'PROJECT');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE scan_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE discovery_method AS ENUM ('AUTOMATIC', 'SITEMAP', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS scans (
  id UUID PRIMARY KEY,
  scan_type scan_type NOT NULL DEFAULT 'CURRENT_PAGE',
  status scan_status NOT NULL DEFAULT 'QUEUED',
  root_url TEXT NOT NULL,
  owner_id TEXT,
  discovery_method discovery_method,
  max_pages INTEGER,
  progress_json JSONB NOT NULL DEFAULT '{"discoveredPages":0,"completedPages":0,"failedPages":0,"issuesFound":0}',
  health_score_json JSONB,
  summary_json JSONB,
  ai_summary_json JSONB,
  evidence_summary_json JSONB,
  artifacts_json JSONB,
  error TEXT,
  scanned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS page_scans (
  id UUID PRIMARY KEY,
  scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status scan_status NOT NULL DEFAULT 'QUEUED',
  error TEXT,
  health_score_json JSONB,
  evidence_summary_json JSONB,
  artifacts_json JSONB,
  scanned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS issues (
  id UUID PRIMARY KEY,
  scan_id UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  page_scan_id UUID REFERENCES page_scans(id) ON DELETE CASCADE,
  is_aggregated BOOLEAN NOT NULL DEFAULT FALSE,
  rule_id TEXT,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  problem TEXT,
  cause TEXT,
  impact TEXT,
  suggested_fix TEXT,
  confidence REAL,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  group_key TEXT,
  evidence_json JSONB NOT NULL DEFAULT '{}',
  occurrence_count INTEGER,
  affected_pages JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS issue_occurrences (
  id UUID PRIMARY KEY,
  aggregated_issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  page_scan_id UUID NOT NULL REFERENCES page_scans(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  evidence_json JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_scans_owner_id ON scans(owner_id);
CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_scans_scan_id ON page_scans(scan_id);
CREATE INDEX IF NOT EXISTS idx_issues_scan_id ON issues(scan_id);
CREATE INDEX IF NOT EXISTS idx_issues_page_scan_id ON issues(page_scan_id);
CREATE INDEX IF NOT EXISTS idx_issue_occurrences_issue_id ON issue_occurrences(aggregated_issue_id);
