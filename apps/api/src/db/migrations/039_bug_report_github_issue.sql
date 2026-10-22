-- Create Bug Report — "Create GitHub Issue" was NOT idempotent: the created
-- issue's number/url were returned to the caller but never persisted
-- anywhere, so reloading the bug report page (or clicking Create again)
-- had no way to know an issue already existed and happily created a
-- SECOND, duplicate GitHub issue for the same bug report. Once set, a bug
-- report's GitHub issue link is permanent — the route this backs
-- (POST /bug-reports/:id/create-github-issue) returns the EXISTING link
-- instead of calling GitHub again whenever these are already populated.

ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS github_repository_id UUID REFERENCES repositories(id) ON DELETE SET NULL;
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS github_issue_number INTEGER;
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS github_issue_url TEXT;
