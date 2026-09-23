-- Phase 19 — indexes for the admin operational activity dashboard's
-- aggregate/status queries (apps/api/src/admin/activity-repository.ts).
-- repository_issue_analyses, repository_fix_proposals, and
-- repository_fix_workflows already have a status index from their own
-- migrations (009/010) — nothing to add for those. sessions(last_used_at)
-- backs the "active user" query (see authorization's own doc comments on
-- last_used_at being the only per-request-refreshed timestamp in the system).

CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);
CREATE INDEX IF NOT EXISTS idx_component_jobs_status ON component_jobs(status);
CREATE INDEX IF NOT EXISTS idx_repository_clone_jobs_status ON repository_clone_jobs(status);
CREATE INDEX IF NOT EXISTS idx_repository_index_jobs_status ON repository_index_jobs(status);
CREATE INDEX IF NOT EXISTS idx_repository_embedding_jobs_status ON repository_embedding_jobs(status);
CREATE INDEX IF NOT EXISTS idx_sessions_last_used_at ON sessions(last_used_at);
