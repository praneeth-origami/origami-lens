-- Phase 17 — Stripe webhook idempotency ledger. Stripe retries webhook
-- deliveries on anything other than a fast 2xx, so the same event id can
-- legitimately arrive more than once; stripe-webhook-service.ts inserts the
-- event id here FIRST (ON CONFLICT DO NOTHING) and only processes it if that
-- insert actually happened — a conflict means "already handled," acked
-- immediately without touching subscriptions again.

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
