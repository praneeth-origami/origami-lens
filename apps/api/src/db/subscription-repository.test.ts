import '../load-env.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPool, isDatabaseEnabled } from './pool.js';
import { SubscriptionRepository } from './subscription-repository.js';

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
    for (const id of createdOrgIds) await pool.query(`DELETE FROM organizations WHERE id = $1`, [id]);
  });
}

describeIfDb('SubscriptionRepository (migration 023, real Postgres)', () => {
  it('getOrCreateForOrganization defaults a brand-new organization to FREE', async () => {
    const repo = new SubscriptionRepository();
    const orgId = await createTestOrganization();

    const subscription = await repo.getOrCreateForOrganization(orgId);
    assert.equal(subscription.plan, 'FREE');
    assert.equal(subscription.status, 'ACTIVE');
    assert.equal(subscription.seatCount, 1);

    // A second call is a no-op fetch, not a duplicate insert (organization_id is UNIQUE).
    const again = await repo.getOrCreateForOrganization(orgId);
    assert.equal(again.plan, 'FREE');
  });

  it('updateFromStripe writes every Stripe-derived field together, and is readable via findByStripeCustomerId/findByStripeSubscriptionId', async () => {
    const repo = new SubscriptionRepository();
    const orgId = await createTestOrganization();
    await repo.getOrCreateForOrganization(orgId);

    await repo.updateFromStripe({
      organizationId: orgId,
      plan: 'PRO',
      status: 'ACTIVE',
      billingInterval: 'MONTHLY',
      seatCount: 1,
      stripeCustomerId: `cus_${orgId}`,
      stripeSubscriptionId: `sub_${orgId}`,
      stripePriceId: 'price_pro_month',
      currentPeriodEnd: '2030-01-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    });

    const byCustomer = await repo.findByStripeCustomerId(`cus_${orgId}`);
    assert.equal(byCustomer?.plan, 'PRO');
    assert.equal(byCustomer?.organizationId, orgId);

    const bySubscription = await repo.findByStripeSubscriptionId(`sub_${orgId}`);
    assert.equal(bySubscription?.plan, 'PRO');
  });

  it('revertToFree clears the Stripe subscription linkage but keeps the customer id', async () => {
    const repo = new SubscriptionRepository();
    const orgId = await createTestOrganization();
    await repo.getOrCreateForOrganization(orgId);
    await repo.updateFromStripe({
      organizationId: orgId,
      plan: 'PRO',
      status: 'ACTIVE',
      billingInterval: 'MONTHLY',
      seatCount: 1,
      stripeCustomerId: `cus_${orgId}`,
      stripeSubscriptionId: `sub_${orgId}`,
      stripePriceId: 'price_pro_month',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });

    await repo.revertToFree(orgId);

    const subscription = await repo.findByOrganizationId(orgId);
    assert.equal(subscription?.plan, 'FREE');
    assert.equal(subscription?.status, 'CANCELED');
    assert.equal(await repo.findStripeSubscriptionId(orgId), undefined);
    assert.equal(await repo.findStripeCustomerId(orgId), `cus_${orgId}`);
  });
});
