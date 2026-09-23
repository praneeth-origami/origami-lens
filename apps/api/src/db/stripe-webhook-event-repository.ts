import { getPool } from './pool.js';

/**
 * Postgres-backed idempotency ledger for `stripe_webhook_events` (migration
 * 024). Stripe retries a webhook delivery on anything other than a fast 2xx
 * response, so the same event id can arrive more than once — stripe-webhook-
 * service.ts calls markProcessed() FIRST and only actually processes the
 * event if it returns true.
 */
export class StripeWebhookEventRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  /** Returns true the first time this event id is seen (and records it), false on every subsequent call for the same id — the caller should skip processing entirely when this returns false. */
  async markProcessed(eventId: string, type: string): Promise<boolean> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    const result = await pool.query(
      `INSERT INTO stripe_webhook_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [eventId, type],
    );
    return result.rows.length > 0;
  }
}
