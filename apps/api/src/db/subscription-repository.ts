import type { BillingInterval, Subscription, SubscriptionPlan, SubscriptionStatus } from '@origami/contracts';
import { getPool } from './pool.js';

function rowToSubscription(row: Record<string, unknown>): Subscription {
  return {
    organizationId: row.organization_id as string,
    plan: row.plan as SubscriptionPlan,
    status: row.status as SubscriptionStatus,
    billingInterval: (row.billing_interval as BillingInterval) ?? null,
    seatCount: row.seat_count as number,
    currentPeriodEnd: row.current_period_end ? (row.current_period_end as Date).toISOString() : undefined,
    cancelAtPeriodEnd: row.cancel_at_period_end as boolean,
  };
}

export interface UpdateFromStripeInput {
  organizationId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  billingInterval: BillingInterval | null;
  seatCount: number;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * Postgres-backed store for `subscriptions` (migration 023). Same
 * "Postgres or disabled, never a JSON fallback" rule as UserRepository/
 * OrganizationRepository — a plan/entitlement is a real authorization
 * boundary, not best-effort feature data.
 */
export class SubscriptionRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async findByOrganizationId(organizationId: string): Promise<Subscription | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM subscriptions WHERE organization_id = $1`, [organizationId]);
    return result.rows[0] ? rowToSubscription(result.rows[0]) : undefined;
  }

  /** Fetch-or-create — every organization implicitly starts on FREE; a row only exists once something (a checkout, or the first quota check) touches it. Race-safe the same way getOrCreatePersonalOrganization is: the loser of a concurrent insert re-reads the winner's row via ON CONFLICT DO UPDATE ... RETURNING rather than erroring. */
  async getOrCreateForOrganization(organizationId: string): Promise<Subscription> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    const existing = await this.findByOrganizationId(organizationId);
    if (existing) return existing;

    const result = await pool.query(
      `INSERT INTO subscriptions (id, organization_id)
       VALUES (gen_random_uuid(), $1)
       ON CONFLICT (organization_id) DO UPDATE SET updated_at = subscriptions.updated_at
       RETURNING *`,
      [organizationId],
    );
    return rowToSubscription(result.rows[0]);
  }

  async findByStripeCustomerId(stripeCustomerId: string): Promise<Subscription | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM subscriptions WHERE stripe_customer_id = $1`, [stripeCustomerId]);
    return result.rows[0] ? rowToSubscription(result.rows[0]) : undefined;
  }

  async findByStripeSubscriptionId(stripeSubscriptionId: string): Promise<Subscription | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT * FROM subscriptions WHERE stripe_subscription_id = $1`, [stripeSubscriptionId]);
    return result.rows[0] ? rowToSubscription(result.rows[0]) : undefined;
  }

  /** Stripe ids are intentionally NOT part of the public `Subscription` contract type (no reason to ever send them to the frontend) — these two accessors are the only way billing-service.ts reads them, for constructing Checkout/Portal sessions and updating seat quantities server-side. */
  async findStripeCustomerId(organizationId: string): Promise<string | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT stripe_customer_id FROM subscriptions WHERE organization_id = $1`, [organizationId]);
    return (result.rows[0]?.stripe_customer_id as string) ?? undefined;
  }

  async findStripeSubscriptionId(organizationId: string): Promise<string | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT stripe_subscription_id FROM subscriptions WHERE organization_id = $1`, [organizationId]);
    return (result.rows[0]?.stripe_subscription_id as string) ?? undefined;
  }

  /** Persists the customer id the moment a Checkout Session is created — before Stripe has confirmed anything — so a later webhook (checkout.session.completed / customer.subscription.updated) can find this org purely from the event's customer id, with no other correlation needed. */
  async setStripeCustomerId(organizationId: string, stripeCustomerId: string): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(
      `UPDATE subscriptions SET stripe_customer_id = $2, updated_at = NOW() WHERE organization_id = $1`,
      [organizationId, stripeCustomerId],
    );
  }

  /** The one write path for every Stripe-sourced state change (checkout completed, subscription updated/deleted, invoice failed/succeeded) — see stripe-webhook-service.ts. Always writes the full set of Stripe-derived fields together so no event can leave the row in a partially-updated state. */
  async updateFromStripe(input: UpdateFromStripeInput): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(
      `UPDATE subscriptions SET
         plan = $2, status = $3, billing_interval = $4, seat_count = $5,
         stripe_customer_id = $6, stripe_subscription_id = $7, stripe_price_id = $8,
         current_period_end = $9, cancel_at_period_end = $10, updated_at = NOW()
       WHERE organization_id = $1`,
      [
        input.organizationId, input.plan, input.status, input.billingInterval, input.seatCount,
        input.stripeCustomerId, input.stripeSubscriptionId, input.stripePriceId,
        input.currentPeriodEnd, input.cancelAtPeriodEnd,
      ],
    );
  }

  /** customer.subscription.deleted's terminal state — reverts to FREE and clears the Stripe subscription/price linkage (the customer id is kept, so a future re-subscribe reuses the same Stripe Customer instead of creating a duplicate). */
  async revertToFree(organizationId: string): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(
      `UPDATE subscriptions SET
         plan = 'FREE', status = 'CANCELED', billing_interval = NULL, seat_count = 1,
         stripe_subscription_id = NULL, stripe_price_id = NULL,
         current_period_end = NULL, cancel_at_period_end = false, updated_at = NOW()
       WHERE organization_id = $1`,
      [organizationId],
    );
  }

  async setStatus(organizationId: string, status: SubscriptionStatus): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(`UPDATE subscriptions SET status = $2, updated_at = NOW() WHERE organization_id = $1`, [organizationId, status]);
  }

  /** PATCH /billing/seats — the Stripe subscription item quantity is updated by the caller first; this only persists the locally-known seat count once that succeeds. */
  async setSeatCount(organizationId: string, seatCount: number): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(`UPDATE subscriptions SET seat_count = $2, updated_at = NOW() WHERE organization_id = $1`, [organizationId, seatCount]);
  }

  /**
   * Candidates for the "plan expiring soon" sweep (subscription-expiry-sweep.ts):
   * only subscriptions actually ENDING (cancel_at_period_end = true — a
   * normal renewal is not "expiring"), whose period ends within the given
   * window, and not already notified for THIS specific period_end value
   * (see migration 034's doc comment for why that's a timestamp, not a bool).
   */
  async findExpiringSoon(withinDays: number): Promise<Subscription[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(
      `SELECT * FROM subscriptions
       WHERE cancel_at_period_end = true
         AND current_period_end IS NOT NULL
         AND current_period_end > NOW()
         AND current_period_end <= NOW() + ($1 * INTERVAL '1 day')
         AND (expiring_soon_notified_for_period_end IS NULL OR expiring_soon_notified_for_period_end != current_period_end)`,
      [withinDays],
    );
    return result.rows.map(rowToSubscription);
  }

  /**
   * Atomically claims the right to send the expiring-soon email — and, in
   * the same statement, re-verifies "still cancel_at_period_end and still
   * within the window" against the column's LIVE value rather than a value
   * read moments earlier and round-tripped through a JS Date (which loses
   * Postgres's sub-millisecond precision — comparing against a re-parsed
   * ISO string can silently never match). Returns the authoritative
   * current_period_end to use in the email, or undefined if nothing was
   * claimed (already claimed this period, no longer cancelling, or the
   * period moved outside the window since findExpiringSoon ran).
   */
  async claimExpiringSoonNotification(organizationId: string, withinDays: number): Promise<{ currentPeriodEnd: string } | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `UPDATE subscriptions SET expiring_soon_notified_for_period_end = current_period_end
       WHERE organization_id = $1
         AND cancel_at_period_end = true
         AND current_period_end IS NOT NULL
         AND current_period_end > NOW()
         AND current_period_end <= NOW() + ($2 * INTERVAL '1 day')
         AND (expiring_soon_notified_for_period_end IS NULL OR expiring_soon_notified_for_period_end != current_period_end)
       RETURNING current_period_end`,
      [organizationId, withinDays],
    );
    return result.rows[0] ? { currentPeriodEnd: (result.rows[0].current_period_end as Date).toISOString() } : undefined;
  }
}
