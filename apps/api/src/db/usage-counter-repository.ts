import type { UsageMetric } from '@origami/contracts';
import { getPool } from './pool.js';

export interface TryConsumeResult {
  allowed: boolean;
  count: number;
}

/** UTC calendar day, as a YYYY-MM-DD string — usage resets at UTC midnight regardless of any individual user's timezone, matching usage_counters.usage_date's DATE column. */
export function currentUsageDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Postgres-backed store for `usage_counters` (migration 025) — the
 * server-side/API-authoritative half of plan enforcement. `tryConsume` is
 * the one atomic primitive every quota check goes through; see
 * entitlement-service.ts's checkAndConsumeQuota, the only caller.
 */
export class UsageCounterRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async getCount(organizationId: string, metric: UsageMetric, usageDate: string): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;
    const result = await pool.query(
      `SELECT count FROM usage_counters WHERE organization_id = $1 AND metric = $2 AND usage_date = $3`,
      [organizationId, metric, usageDate],
    );
    return result.rows[0] ? (result.rows[0].count as number) : 0;
  }

  /**
   * Atomically increments today's counter for (organizationId, metric) and
   * reports whether the action is allowed — race-safe under concurrent
   * requests without a transaction or row lock:
   *
   * 1. `UPDATE ... SET count = count + 1 WHERE ... AND count < limit RETURNING count`
   *    — the common case (a row already exists for today). If this updates
   *    a row, the increment and the limit check happened as one atomic
   *    operation; no other request can interleave between them.
   * 2. If it updated zero rows, that's either "no row yet today" or
   *    "already at/over the limit" — indistinguishable from (1) alone, so
   *    try `INSERT ... VALUES (..., 1) ON CONFLICT (organization_id, metric,
   *    usage_date) DO NOTHING RETURNING count`. If this inserts, today's
   *    first use is allowed (assumes limit >= 1, always true in practice).
   * 3. If the insert also affected zero rows, another concurrent request
   *    won the insert between steps 1 and 2 — retry the UPDATE once, which
   *    now has a real row to work against.
   */
  async tryConsume(organizationId: string, metric: UsageMetric, usageDate: string, limit: number): Promise<TryConsumeResult> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    const attemptUpdate = async (): Promise<TryConsumeResult | undefined> => {
      const result = await pool.query(
        `UPDATE usage_counters SET count = count + 1, updated_at = NOW()
         WHERE organization_id = $1 AND metric = $2 AND usage_date = $3 AND count < $4
         RETURNING count`,
        [organizationId, metric, usageDate, limit],
      );
      return result.rows[0] ? { allowed: true, count: result.rows[0].count as number } : undefined;
    };

    const updated = await attemptUpdate();
    if (updated) return updated;

    const inserted = await pool.query(
      `INSERT INTO usage_counters (id, organization_id, metric, usage_date, count)
       VALUES (gen_random_uuid(), $1, $2, $3, 1)
       ON CONFLICT (organization_id, metric, usage_date) DO NOTHING
       RETURNING count`,
      [organizationId, metric, usageDate],
    );
    if (inserted.rows[0]) return { allowed: true, count: inserted.rows[0].count as number };

    const retried = await attemptUpdate();
    if (retried) return retried;

    // A concurrent request already consumed the last slot between our
    // insert-loss and this retry — the row exists but is now at/over limit.
    const current = await this.getCount(organizationId, metric, usageDate);
    return { allowed: false, count: current };
  }

  /**
   * Atomically "claims" the right to send today's plan-limit-reached email
   * for this (organizationId, metric) — an UPDATE guarded by `IS NULL`, so
   * only the FIRST call for a given row ever returns `true`; every
   * subsequent blocked request that same day gets `false` and must not
   * send anything. Requires the row to already exist (tryConsume always
   * creates it before a rejection is possible), so no INSERT branch is
   * needed here unlike tryConsume.
   */
  async claimLimitReachedNotification(organizationId: string, metric: UsageMetric, usageDate: string): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;
    const result = await pool.query(
      `UPDATE usage_counters SET limit_reached_notified_at = NOW()
       WHERE organization_id = $1 AND metric = $2 AND usage_date = $3 AND limit_reached_notified_at IS NULL
       RETURNING id`,
      [organizationId, metric, usageDate],
    );
    return result.rows.length > 0;
  }
}
