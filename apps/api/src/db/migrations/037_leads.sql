-- Origami Lead Generation ("Talk to Origami", roadmap Phase 8) — a lead is
-- always scoped to the organization that owned the scan/report it was
-- submitted from (never a client-supplied workspace id — see
-- lead-service.ts), and to the scan it references, so it can never be
-- fabricated for a scan the caller doesn't own. `scan_id` is nullable only
-- because a lead could conceivably be submitted with no specific report in
-- context; every real submission from the product always sets it.

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  scan_id UUID REFERENCES scans(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  message TEXT,
  domain TEXT,
  health_score INTEGER,
  issue_summary_json JSONB,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_organization_id ON leads(organization_id);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
