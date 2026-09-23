-- Phase 18 — expands organization_role (migration 015) from just
-- ('OWNER','MEMBER') to the full workspace-role set. This is the
-- workspace-level half of RBAC — see authorization/workspace-permissions.ts.
-- Enum-value-only, no row in this file uses any of the new values (Postgres
-- forbids using a newly-added enum value in the same transaction that added
-- it — same constraint that split migrations 020/021 apart). No backfill:
-- every existing membership row stays OWNER, which is already correct —
-- today every organization is a personal, single-member workspace.

ALTER TYPE organization_role ADD VALUE IF NOT EXISTS 'ADMIN';
ALTER TYPE organization_role ADD VALUE IF NOT EXISTS 'VIEWER';
ALTER TYPE organization_role ADD VALUE IF NOT EXISTS 'CLIENT_VIEWER';
