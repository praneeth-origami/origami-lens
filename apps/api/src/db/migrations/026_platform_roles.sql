-- Phase 18 — platform roles (FOUNDER/ADMIN/USER), the platform-level half of
-- the RBAC system. Deliberately its own enum/column, NOT a reuse of
-- user_persona's existing 'FOUNDER' value (migration 017) — that's an
-- unrelated, purely descriptive onboarding self-report ("I run a company or
-- product") that nothing branches on; this platform_role is a real
-- authorization boundary. Every existing user safely defaults to 'USER' —
-- no backfill needed. See authorization/platform-permissions.ts.

DO $$ BEGIN
  CREATE TYPE platform_role AS ENUM ('FOUNDER', 'ADMIN', 'USER');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_role platform_role NOT NULL DEFAULT 'USER';
