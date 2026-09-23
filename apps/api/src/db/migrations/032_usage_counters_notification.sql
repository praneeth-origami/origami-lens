-- Lets checkAndConsumeQuota (entitlement-service.ts) send a "plan limit
-- reached" email at most once per (organization, metric, day) by having the
-- first rejection of the day atomically "claim" this column — see
-- usage-counter-repository.ts's claimLimitReachedNotification.

ALTER TABLE usage_counters ADD COLUMN IF NOT EXISTS limit_reached_notified_at TIMESTAMPTZ;
