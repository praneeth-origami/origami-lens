-- Phase 18 — a minimal, generic audit trail for security-sensitive RBAC
-- events (platform-role changes, workspace membership/role changes,
-- ownership transfers, Founder bootstrap) — see
-- authorization/audit-log-repository.ts's recordAuditEvent(), the only
-- writer. Deliberately generic/narrow rather than a general-purpose event
-- bus: metadata is a free-form JSONB blob per event_type, not a fixed
-- per-event-type schema.

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id);
