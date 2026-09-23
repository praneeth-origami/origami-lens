import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import {
  BillingError,
  createBillingPortalSession,
  createCheckoutSession,
  getCheckoutSessionStatus,
  updateSeats,
  type BillingSubscriptionRepo,
} from './billing-service.js';

const PRICE_ENV = {
  STRIPE_PRICE_DEVELOPER_MONTHLY: 'price_dev_month',
  STRIPE_PRICE_PRO_MONTHLY: 'price_pro_month',
  STRIPE_PRICE_PRO_ANNUAL: 'price_pro_annual',
  STRIPE_PRICE_TEAM_MONTHLY: 'price_team_month',
  STRIPE_PRICE_TEAM_SEAT_MONTHLY: 'price_team_seat',
};
for (const [key, value] of Object.entries(PRICE_ENV)) process.env[key] = value;

function fakeSubscriptionRepo(overrides: Partial<BillingSubscriptionRepo> = {}): BillingSubscriptionRepo & { setStripeCustomerIdCalls: string[]; setSeatCountCalls: number[] } {
  const setStripeCustomerIdCalls: string[] = [];
  const setSeatCountCalls: number[] = [];
  return {
    setStripeCustomerIdCalls,
    setSeatCountCalls,
    getOrCreateForOrganization: async () => ({ organizationId: 'org-1', plan: 'FREE', status: 'ACTIVE', billingInterval: null, seatCount: 1, cancelAtPeriodEnd: false }),
    findStripeCustomerId: async () => undefined,
    findStripeSubscriptionId: async () => undefined,
    setStripeCustomerId: async (_orgId, customerId) => {
      setStripeCustomerIdCalls.push(customerId);
    },
    setSeatCount: async (_orgId, seats) => {
      setSeatCountCalls.push(seats);
    },
    ...overrides,
  };
}

describe('createCheckoutSession', () => {
  it('throws BILLING_NOT_CONFIGURED when Stripe is not configured', async () => {
    await assert.rejects(
      () => createCheckoutSession(
        { stripe: null, subscriptionRepo: fakeSubscriptionRepo(), webAppBaseUrl: 'http://localhost:5173', organizationName: 'Org' },
        'org-1',
        { plan: 'PRO', interval: 'MONTHLY' },
      ),
      (error: unknown) => error instanceof BillingError && error.code === 'BILLING_NOT_CONFIGURED',
    );
  });

  it('rejects FREE and inactive (AGENCY) plans with INVALID_PLAN', async () => {
    const fakeStripe = {} as unknown as Stripe;
    for (const plan of ['FREE', 'AGENCY'] as const) {
      await assert.rejects(
        () => createCheckoutSession(
          { stripe: fakeStripe, subscriptionRepo: fakeSubscriptionRepo(), webAppBaseUrl: 'http://localhost:5173', organizationName: 'Org' },
          'org-1',
          { plan, interval: 'MONTHLY' },
        ),
        (error: unknown) => error instanceof BillingError && error.code === 'INVALID_PLAN',
      );
    }
  });

  it('rejects a Team seat count below the included minimum with SEAT_COUNT_INVALID', async () => {
    const fakeStripe = {} as unknown as Stripe;
    await assert.rejects(
      () => createCheckoutSession(
        { stripe: fakeStripe, subscriptionRepo: fakeSubscriptionRepo(), webAppBaseUrl: 'http://localhost:5173', organizationName: 'Org' },
        'org-1',
        { plan: 'TEAM', interval: 'MONTHLY', seats: 1 },
      ),
      (error: unknown) => error instanceof BillingError && error.code === 'SEAT_COUNT_INVALID',
    );
  });

  it('creates a Stripe customer on first checkout, persists it, and builds the correct line items', async () => {
    const createdSessions: Stripe.Checkout.SessionCreateParams[] = [];
    const fakeStripe = {
      customers: { create: async () => ({ id: 'cus_new' }) },
      checkout: { sessions: { create: async (params: Stripe.Checkout.SessionCreateParams) => { createdSessions.push(params); return { url: 'https://checkout.stripe.com/session_123' }; } } },
    } as unknown as Stripe;
    const repo = fakeSubscriptionRepo();

    const result = await createCheckoutSession(
      { stripe: fakeStripe, subscriptionRepo: repo, webAppBaseUrl: 'http://localhost:5173', organizationName: 'Org', customerEmail: 'a@b.com' },
      'org-1',
      { plan: 'TEAM', interval: 'MONTHLY', seats: 5 },
    );

    assert.equal(result.url, 'https://checkout.stripe.com/session_123');
    assert.deepEqual(repo.setStripeCustomerIdCalls, ['cus_new']);
    assert.equal(createdSessions[0].customer, 'cus_new');
    assert.deepEqual(createdSessions[0].line_items, [
      { price: 'price_team_month', quantity: 1 },
      { price: 'price_team_seat', quantity: 2 }, // 5 requested - 3 included
    ]);
    assert.match(createdSessions[0].success_url!, /^http:\/\/localhost:5173\/billing\/success\?session_id=/);
  });

  it('reuses an existing Stripe customer id instead of creating a new one', async () => {
    let customerCreateCalls = 0;
    const fakeStripe = {
      customers: { create: async () => { customerCreateCalls += 1; return { id: 'cus_should_not_be_used' }; } },
      checkout: { sessions: { create: async () => ({ url: 'https://checkout.stripe.com/x' }) } },
    } as unknown as Stripe;
    const repo = fakeSubscriptionRepo({ findStripeCustomerId: async () => 'cus_existing' });

    await createCheckoutSession(
      { stripe: fakeStripe, subscriptionRepo: repo, webAppBaseUrl: 'http://localhost:5173', organizationName: 'Org' },
      'org-1',
      { plan: 'PRO', interval: 'ANNUAL' },
    );

    assert.equal(customerCreateCalls, 0);
  });
});

describe('createBillingPortalSession', () => {
  it('throws ORGANIZATION_NOT_FOUND when the organization has no Stripe customer yet', async () => {
    const fakeStripe = {} as unknown as Stripe;
    await assert.rejects(
      () => createBillingPortalSession({ stripe: fakeStripe, subscriptionRepo: fakeSubscriptionRepo(), webAppBaseUrl: 'http://localhost:5173' }, 'org-1'),
      (error: unknown) => error instanceof BillingError && error.code === 'ORGANIZATION_NOT_FOUND',
    );
  });

  it('returns the portal session url for an organization with a Stripe customer', async () => {
    const fakeStripe = {
      billingPortal: { sessions: { create: async (params: Stripe.BillingPortal.SessionCreateParams) => ({ url: `https://billing.stripe.com/p/${params.customer}` }) } },
    } as unknown as Stripe;
    const repo = fakeSubscriptionRepo({ findStripeCustomerId: async () => 'cus_existing' });

    const result = await createBillingPortalSession({ stripe: fakeStripe, subscriptionRepo: repo, webAppBaseUrl: 'http://localhost:5173' }, 'org-1');
    assert.equal(result.url, 'https://billing.stripe.com/p/cus_existing');
  });
});

describe('getCheckoutSessionStatus', () => {
  it('throws CHECKOUT_SESSION_NOT_FOUND when Stripe cannot find the session', async () => {
    const fakeStripe = { checkout: { sessions: { retrieve: async () => { throw new Error('No such session'); } } } } as unknown as Stripe;
    await assert.rejects(
      () => getCheckoutSessionStatus(fakeStripe, fakeSubscriptionRepo(), 'org-1', 'cs_missing'),
      (error: unknown) => error instanceof BillingError && error.code === 'CHECKOUT_SESSION_NOT_FOUND',
    );
  });

  it('never grants access itself — returns whatever the local subscription currently is, unmodified', async () => {
    const fakeStripe = { checkout: { sessions: { retrieve: async () => ({ status: 'complete' }) } } } as unknown as Stripe;
    const repo = fakeSubscriptionRepo();
    const result = await getCheckoutSessionStatus(fakeStripe, repo, 'org-1', 'cs_123');
    assert.equal(result.status, 'complete');
    assert.equal(result.subscription.plan, 'FREE'); // still FREE — only the webhook would ever change this
  });
});

describe('updateSeats', () => {
  it('rejects for a non-TEAM plan with INVALID_PLAN', async () => {
    const fakeStripe = {} as unknown as Stripe;
    await assert.rejects(
      () => updateSeats({ stripe: fakeStripe, subscriptionRepo: fakeSubscriptionRepo() }, 'org-1', 5),
      (error: unknown) => error instanceof BillingError && error.code === 'INVALID_PLAN',
    );
  });

  it('rejects a seat count below the Team-included minimum', async () => {
    const fakeStripe = {} as unknown as Stripe;
    const repo = fakeSubscriptionRepo({ getOrCreateForOrganization: async () => ({ organizationId: 'org-1', plan: 'TEAM', status: 'ACTIVE', billingInterval: 'MONTHLY', seatCount: 3, cancelAtPeriodEnd: false }) });
    await assert.rejects(
      () => updateSeats({ stripe: fakeStripe, subscriptionRepo: repo }, 'org-1', 2),
      (error: unknown) => error instanceof BillingError && error.code === 'SEAT_COUNT_INVALID',
    );
  });

  it('creates a new seat subscription item when increasing seats for the first time', async () => {
    const createCalls: unknown[] = [];
    const fakeStripe = {
      subscriptions: { retrieve: async () => ({ items: { data: [{ id: 'si_base', price: { id: 'price_team_month' } }] } }) },
      subscriptionItems: { create: async (params: unknown) => { createCalls.push(params); }, update: async () => { throw new Error('should not update'); } },
    } as unknown as Stripe;
    const repo = fakeSubscriptionRepo({
      getOrCreateForOrganization: async () => ({ organizationId: 'org-1', plan: 'TEAM', status: 'ACTIVE', billingInterval: 'MONTHLY', seatCount: 3, cancelAtPeriodEnd: false }),
      findStripeSubscriptionId: async () => 'sub_123',
    });

    await updateSeats({ stripe: fakeStripe, subscriptionRepo: repo }, 'org-1', 5);

    assert.equal(createCalls.length, 1);
    assert.deepEqual(createCalls[0], { subscription: 'sub_123', price: 'price_team_seat', quantity: 2 });
    assert.deepEqual(repo.setSeatCountCalls, [5]);
  });

  it('removes the seat item entirely when seats drop back to the included amount', async () => {
    const delCalls: string[] = [];
    const fakeStripe = {
      subscriptions: { retrieve: async () => ({ items: { data: [{ id: 'si_base', price: { id: 'price_team_month' } }, { id: 'si_seat', price: { id: 'price_team_seat' }, quantity: 2 }] } }) },
      subscriptionItems: { del: async (id: string) => { delCalls.push(id); } },
    } as unknown as Stripe;
    const repo = fakeSubscriptionRepo({
      getOrCreateForOrganization: async () => ({ organizationId: 'org-1', plan: 'TEAM', status: 'ACTIVE', billingInterval: 'MONTHLY', seatCount: 5, cancelAtPeriodEnd: false }),
      findStripeSubscriptionId: async () => 'sub_123',
    });

    await updateSeats({ stripe: fakeStripe, subscriptionRepo: repo }, 'org-1', 3);

    assert.deepEqual(delCalls, ['si_seat']);
    assert.deepEqual(repo.setSeatCountCalls, [3]);
  });
});
