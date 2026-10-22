-- Create GitHub Issue (scan findings) — "Create GitHub Issue" was not
-- idempotent: the created issue's number/url were returned to the caller
-- but never persisted anywhere, so a repeated click (or two near-
-- simultaneous clicks) happily created a SECOND, duplicate GitHub issue for
-- the same finding. Distinct from migration 039 (bug_reports, single-repo):
-- a scan finding may legitimately be filed in more than one connected
-- repository (see Issue.githubIssueLinks), so this is a proper one-to-many
-- junction table rather than flat columns on `issues` — but within the SAME
-- repository, only one link may ever exist, enforced by the UNIQUE
-- constraint below (also the atomic primitive the duplicate-prevention fix
-- relies on: INSERT ... ON CONFLICT DO NOTHING).

CREATE TABLE IF NOT EXISTS github_issue_links (
  id UUID PRIMARY KEY,
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  github_owner TEXT NOT NULL,
  github_repository TEXT NOT NULL,
  github_issue_number INTEGER NOT NULL,
  github_issue_url TEXT NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (issue_id, repository_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_github_issue_links_issue_id ON github_issue_links(issue_id);
