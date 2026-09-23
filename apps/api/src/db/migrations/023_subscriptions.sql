-- Phase 17 — Stripe subscriptions. A subscription belongs to an
-- ORGANIZATION (migration 015), not a user directly: for a personal
-- organization that's equivalent to per-user billing, and it naturally
-- extends to Team organizations with multiple members sharing one plan.
-- There is no backfill here — every organization implicitly starts on FREE
-- and gets a row lazily on first entitlement check (see
-- subscription-repository.ts's getOrCreateForOrganization, the exact same
-- lazy-create pattern as organization-repository.ts's
-- getOrCreatePersonalOrganization).

DO $$ BEGIN
  CREATE TYPE subscription_plan AS ENUM ('FREE', 'DEVELOPER', 'PRO', 'TEAM', 'AGENCY');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE subscription_status AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE', 'TRIALING');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE billing_interval AS ENUM ('MONTHLY', 'ANNUAL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan subscription_plan NOT NULL DEFAULT 'FREE',
  status subscription_status NOT NULL DEFAULT 'ACTIVE',
  -- NULL for FREE, which has no Stripe price/interval at all.
  billing_interval billing_interval,
  seat_count INT NOT NULL DEFAULT 1,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Webhook lookups key off these; partial (not every row has a Stripe
-- customer/subscription yet — FREE orgs may never get one).
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_stripe_customer_id ON subscriptions(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_stripe_subscription_id ON subscriptions(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
