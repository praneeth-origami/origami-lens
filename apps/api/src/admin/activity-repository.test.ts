import '../load-env.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPool, isDatabaseEnabled } from '../db/pool.js';
import { countActiveNow, listActiveActivity, listRecentActivity, countSubscriptionsByPlanAndStatus, sumUsageTodayByPlan } from './activity-repository.js';

const dbAvailable = isDatabaseEnabled();
const describeIfDb = dbAvailable ? describe : describe.skip;

const cleanupScanIds: string[] = [];
const cleanupComponentJobIds: string[] = [];
const cleanupOrgIds: string[] = [];

async function createTestOrganization(): Promise<string> {
  const pool = getPool()!;
  const id = randomUUID();
  await pool.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [id, `activity-test-${id}`]);
  cleanupOrgIds.push(id);
  return id;
}

async function insertScan(organizationId: string, status: string, rootUrl = 'https://activity-test.example.com'): Promise<string> {
  const pool = getPool()!;
  const id = randomUUID();
  await pool.query(
    `INSERT INTO scans (id, scan_type, status, root_url, organization_id) VALUES ($1, 'CURRENT_PAGE', $2, $3, $4)`,
    [id, status, rootUrl, organizationId],
  );
  cleanupScanIds.push(id);
  return id;
}

async function insertComponentJob(organizationId: string, status: string): Promise<string> {
  const pool = getPool()!;
  const id = randomUUID();
  await pool.query(
    `INSERT INTO component_jobs (id, source_url, target, status, organization_id) VALUES ($1, 'https://activity-test.example.com/page', 'REACT', $2, $3)`,
    [id, status, organizationId],
  );
  cleanupComponentJobIds.push(id);
  return id;
}

if (dbAvailable) {
  after(async () => {
    const pool = getPool()!;
    for (const id of cleanupScanIds) await pool.query(`DELETE FROM scans WHERE id = $1`, [id]);
    for (const id of cleanupComponentJobIds) await pool.query(`DELETE FROM component_jobs WHERE id = $1`, [id]);
    for (const id of cleanupOrgIds) await pool.query(`DELETE FROM organizations WHERE id = $1`, [id]);
  });
}

describeIfDb('activity-repository (migration 029, real Postgres)', () => {
  it('countActiveNow counts a real RUNNING scan and a real QUEUED component job', async () => {
    const orgId = await createTestOrganization();
    await insertScan(orgId, 'RUNNING');
    await insertComponentJob(orgId, 'QUEUED');

    const before = await countActiveNow();
    // Sanity: the counts are real, non-negative, and at least reflect what we just inserted
    // (the dev DB may already have other active rows from other tests/usage).
    assert.ok(before.activeScans >= 1);
    assert.ok(before.activeAiJobs >= 1);
  });

  it('listActiveActivity includes a freshly-inserted RUNNING scan with the right shape, and excludes a COMPLETED one', async () => {
    const orgId = await createTestOrganization();
    const runningId = await insertScan(orgId, 'RUNNING', 'https://running.activity-test.example.com');
    const completedId = await insertScan(orgId, 'COMPLETED', 'https://completed.activity-test.example.com');

    const items = await listActiveActivity({ type: 'SCAN', limit: 200 });
    const found = items.find((item) => item.id === runningId);
    assert.ok(found, 'the RUNNING scan should appear in active activity');
    assert.equal(found?.type, 'SCAN');
    assert.equal(found?.status, 'RUNNING');
    assert.equal(found?.organizationId, orgId);
    assert.equal(found?.targetLabel, 'running.activity-test.example.com');

    assert.equal(
      items.some((item) => item.id === completedId),
      false,
      'a COMPLETED scan must never appear in the active list',
    );
  });

  it('listRecentActivity includes a freshly-COMPLETED scan and excludes a still-RUNNING one', async () => {
    const orgId = await createTestOrganization();
    const completedId = await insertScan(orgId, 'COMPLETED', 'https://recent.activity-test.example.com');
    const runningId = await insertScan(orgId, 'RUNNING', 'https://still-running.activity-test.example.com');

    const items = await listRecentActivity(100);
    assert.ok(
      items.some((item) => item.id === completedId),
      'a recently-COMPLETED scan should appear in recent activity',
    );
    assert.equal(
      items.some((item) => item.id === runningId),
      false,
      'a RUNNING (non-terminal) scan must never appear in recent activity',
    );
  });

  it('listActiveActivity respects the status filter', async () => {
    const orgId = await createTestOrganization();
    await insertScan(orgId, 'QUEUED', 'https://queued-only.activity-test.example.com');

    const items = await listActiveActivity({ type: 'SCAN', status: 'RUNNING', limit: 200 });
    assert.equal(
      items.some((item) => item.targetLabel === 'queued-only.activity-test.example.com'),
      false,
      'a QUEUED scan must not appear when filtering for status=RUNNING',
    );
  });

  it('countSubscriptionsByPlanAndStatus always returns every plan/status key, defaulting to 0', async () => {
    const breakdown = await countSubscriptionsByPlanAndStatus();
    for (const plan of ['FREE', 'DEVELOPER', 'PRO', 'TEAM', 'AGENCY'] as const) {
      assert.ok(typeof breakdown.byPlan[plan] === 'number');
    }
    for (const status of ['ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE', 'TRIALING'] as const) {
      assert.ok(typeof breakdown.byStatus[status] === 'number');
    }
  });

  it('sumUsageTodayByPlan always returns all plans, defaulting to zero counts', async () => {
    const usage = await sumUsageTodayByPlan();
    const plans = usage.map((u) => u.plan);
    for (const plan of ['FREE', 'DEVELOPER', 'PRO', 'TEAM', 'AGENCY']) {
      assert.ok(plans.includes(plan as never));
    }
  });
});
