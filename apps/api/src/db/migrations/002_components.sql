-- Kept in sync with 003_component_cancelled_status.sql, which is what
-- actually adds CANCELLED for any database that migrated before it existed —
-- editing the list here only affects a brand-new database created from
-- scratch (CREATE TYPE is skipped as a no-op once the type already exists).
DO $$ BEGIN
  CREATE TYPE component_generation_status AS ENUM ('QUEUED', 'RUNNING', 'BLOCKED_PRIVACY', 'COMPLETED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE code_target AS ENUM ('REACT', 'NEXT_JS', 'TAILWIND', 'HTML_CSS');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS component_jobs (
  id UUID PRIMARY KEY,
  owner_id TEXT,
  source_url TEXT NOT NULL,
  page_title TEXT,
  target code_target NOT NULL,
  status component_generation_status NOT NULL DEFAULT 'QUEUED',
  component_name TEXT,
  evidence_json JSONB,
  result_json JSONB,
  verification_json JSONB,
  ai_available BOOLEAN NOT NULL DEFAULT FALSE,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_component_jobs_owner_id ON component_jobs(owner_id);
CREATE INDEX IF NOT EXISTS idx_component_jobs_created_at ON component_jobs(created_at DESC);
