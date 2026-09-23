import '../load-env.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPool, isDatabaseEnabled } from './pool.js';
import { UsageCounterRepository, currentUsageDate } from './usage-counter-repository.js';

/** Requires a real Postgres instance (migration 025) — skips rather than fails when DATABASE_URL isn't configured, matching this project's convention (see user-repository.test.ts). */
const dbAvailable = isDatabaseEnabled();
const describeIfDb = dbAvailable ? describe : describe.skip;

const createdOrgIds: string[] = [];

async function createTestOrganization(): Promise<string> {
  const pool = getPool()!;
  const id = randomUUID();
  await pool.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [id, `Test Org ${id}`]);
  createdOrgIds.push(id);
  return id;
}

if (dbAvailable) {
  after(async () => {
    const pool = getPool()!;
    // ON DELETE CASCADE takes usage_counters/subscriptions rows with it.
    for (const id of createdOrgIds) await pool.query(`DELETE FROM organizations WHERE id = $1`, [id]);
  });
}

describeIfDb('UsageCounterRepository (migration 025, real Postgres)', () => {
  it('allows exactly `limit` consumptions then denies the next one, without exceeding the stored count', async () => {
    const repo = new UsageCounterRepository();
    const orgId = await createTestOrganization();
    const date = currentUsageDate();

    for (let i = 1; i <= 3; i++) {
      const result = await repo.tryConsume(orgId, 'INSPECTION', date, 3);
      assert.equal(result.allowed, true, `attempt ${i} should be allowed`);
      assert.equal(result.count, i);
    }

    const denied = await repo.tryConsume(orgId, 'INSPECTION', date, 3);
    assert.equal(denied.allowed, false);

    assert.equal(await repo.getCount(orgId, 'INSPECTION', date), 3);
  });

  it('tracks each metric independently for the same organization and day', async () => {
    const repo = new UsageCounterRepository();
    const orgId = await createTestOrganization();
    const date = currentUsageDate();

    await repo.tryConsume(orgId, 'INSPECTION', date, 10);
    await repo.tryConsume(orgId, 'AI_QUESTION', date, 10);
    await repo.tryConsume(orgId, 'AI_QUESTION', date, 10);

    assert.equal(await repo.getCount(orgId, 'INSPECTION', date), 1);
    assert.equal(await repo.getCount(orgId, 'AI_QUESTION', date), 2);
    assert.equal(await repo.getCount(orgId, 'SCREENSHOT_TO_CODE', date), 0);
  });

  it('remains race-safe under concurrent consumption — exactly `limit` of N concurrent calls succeed', async () => {
    const repo = new UsageCounterRepository();
    const orgId = await createTestOrganization();
    const date = currentUsageDate();
    const limit = 5;

    const results = await Promise.all(Array.from({ length: 20 }, () => repo.tryConsume(orgId, 'INSPECTION', date, limit)));
    const allowedCount = results.filter((r) => r.allowed).length;

    assert.equal(allowedCount, limit);
    assert.equal(await repo.getCount(orgId, 'INSPECTION', date), limit);
  });

  it('a different usage_date is a fresh counter (no cross-day leakage)', async () => {
    const repo = new UsageCounterRepository();
    const orgId = await createTestOrganization();

    await repo.tryConsume(orgId, 'INSPECTION', '2020-01-01', 1);
    const today = await repo.tryConsume(orgId, 'INSPECTION', currentUsageDate(), 1);

    assert.equal(today.allowed, true);
    assert.equal(today.count, 1);
  });
});
