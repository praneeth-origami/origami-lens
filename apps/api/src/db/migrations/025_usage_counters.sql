-- Phase 17 — daily per-organization usage counters, the server-side/
-- API-authoritative half of plan enforcement (the other half is
-- subscriptions.plan + PLAN_DEFINITIONS in @origami/contracts). One row per
-- (organization, metric, day); usage-counter-repository.ts's tryConsume
-- increments this atomically and denies once a plan's limit is reached,
-- entirely via ON CONFLICT/conditional UPDATE — no transaction/row lock
-- needed, matching this codebase's existing idempotency style (see
-- organization-repository.ts's getOrCreatePersonalOrganization).

CREATE TABLE IF NOT EXISTS usage_counters (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- 'INSPECTION' | 'AI_QUESTION' | 'SCREENSHOT_TO_CODE' (UsageMetric in
  -- @origami/contracts) — plain TEXT rather than an enum since this is an
  -- internal bookkeeping key, never a value stored alongside untrusted
  -- external data the way subscription_plan/subscription_status are.
  metric TEXT NOT NULL,
  usage_date DATE NOT NULL,
  count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_usage_counters_org_metric_date UNIQUE (organization_id, metric, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_usage_counters_organization_id ON usage_counters(organization_id);
