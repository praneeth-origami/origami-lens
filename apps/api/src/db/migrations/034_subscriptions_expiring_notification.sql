-- Lets the subscription-expiry sweep (subscription-expiry-sweep.ts) send a
-- "plan expiring soon" email at most once per billing period. Stores WHICH
-- current_period_end value was already notified for, rather than a plain
-- boolean, so a renewal (current_period_end moving forward) naturally
-- re-arms the notification for the next period without any reset logic.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS expiring_soon_notified_for_period_end TIMESTAMPTZ;
