-- Continuous Website Monitoring (V3) — a scheduled, workspace-owned scan of
-- a saved website, compared against its own scan history to detect
-- regressions. Deliberately reuses the existing scans/issues pipeline as
-- the source of truth for scan data (see scans.monitored_site_id below) —
-- this migration adds no second scanning engine, only the configuration
-- and event tables a scheduler/regression-comparison layer needs on top of
-- it.

DO $$ BEGIN
  CREATE TYPE monitoring_frequency AS ENUM ('DAILY');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- PENDING: created, baseline scan not completed yet. HEALTHY: most recent
-- scan completed with no open regression. REGRESSION: most recent scan's
-- comparison produced at least one monitoring_events row still OPEN.
-- FAILED: most recent scan attempt itself failed (distinct from a
-- completed scan that happens to show a regression). Pausing is tracked by
-- `enabled`, not a status value, so a paused site keeps showing its last
-- real health status underneath the "Paused" badge rather than losing it.
DO $$ BEGIN
  CREATE TYPE monitoring_site_status AS ENUM ('PENDING', 'HEALTHY', 'REGRESSION', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS monitored_sites (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  frequency monitoring_frequency NOT NULL DEFAULT 'DAILY',
  status monitoring_site_status NOT NULL DEFAULT 'PENDING',
  -- First scan ever run for this site — frozen once set, never reassigned
  -- (see monitored-site-service.ts). Distinct from "the previous scan" used
  -- for day-over-day regression comparison (scans.monitored_site_id lets
  -- that be queried directly: the most recent completed scan before the
  -- current one), which intentionally does NOT always equal this baseline.
  baseline_scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  last_scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  last_scan_at TIMESTAMPTZ,
  last_scan_error TEXT,
  next_scan_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitored_sites_organization_id ON monitored_sites(organization_id);
-- Backs the scheduler sweep's due-site query (WHERE enabled AND next_scan_at <= NOW()).
CREATE INDEX IF NOT EXISTS idx_monitored_sites_due ON monitored_sites(next_scan_at) WHERE enabled = true;

-- The existing scans table remains the sole source of scan data (health
-- score, issues, evidence, screenshots) — this is the only column
-- monitoring adds to it, linking a scan back to the monitor that requested
-- it (NULL for every ordinary, non-monitoring scan, including a monitored
-- site's own manually-triggered "Run Now" re-scans of the same site — those
-- still set this column, since they're the same monitored_site_id).
ALTER TABLE scans ADD COLUMN IF NOT EXISTS monitored_site_id UUID REFERENCES monitored_sites(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_scans_monitored_site_id ON scans(monitored_site_id, created_at DESC);

CREATE TABLE IF NOT EXISTS monitoring_events (
  id UUID PRIMARY KEY,
  monitored_site_id UUID NOT NULL REFERENCES monitored_sites(id) ON DELETE CASCADE,
  scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  previous_scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  previous_value JSONB,
  current_value JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Deployment-correlation extension point (future-ready, not read/written
  -- by any V3 logic) — see the roadmap's "Deployment Correlation" section.
  deployment_id TEXT,
  commit_sha TEXT,
  repository_id UUID REFERENCES repositories(id) ON DELETE SET NULL,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitoring_events_monitored_site_id ON monitoring_events(monitored_site_id, created_at DESC);
