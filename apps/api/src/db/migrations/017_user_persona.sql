-- Phase 3 — persona capture. Purely descriptive (migration comment in
-- contracts' Persona type explains why): a one-time onboarding question
-- asked after first login, stored here so later persona-specific features
-- (Phase 4) have real data instead of guessing. Nullable — most existing
-- users predate this and haven't answered it yet; the frontend uses NULL to
-- decide whether to show the onboarding prompt.

DO $$ BEGIN
  CREATE TYPE user_persona AS ENUM ('DEVELOPER', 'FOUNDER', 'AGENCY', 'DESIGNER', 'QA_TEAM', 'PRODUCT_MANAGER');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS persona user_persona;
