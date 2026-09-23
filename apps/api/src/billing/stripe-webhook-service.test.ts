import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import type { Subscription } from '@origami/contracts';
import { handleStripeWebhookEvent, type WebhookSubscriptionRepo } from './stripe-webhook-service.js';

const PRICE_ENV = {
  STRIPE_PRICE_DEVELOPER_MONTHLY: 'price_dev_month',
  STRIPE_PRICE_PRO_MONTHLY: 'price_pro_month',
  STRIPE_PRICE_TEAM_MONTHLY: 'price_team_month',
  STRIPE_PRICE_TEAM_SEAT_MONTHLY: 'price_team_seat',
} as const;
const original = Object.fromEntries(Object.keys(PRICE_ENV).map((k) => [k, process.env[k]]));

for (const [key, value] of Object.entries(PRICE_ENV)) process.env[key] = value;
afterEach(() => {
  for (const key of Object.keys(PRICE_ENV)) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  for (const [key, value] of Object.entries(PRICE_ENV)) process.env[key] = value;
});

function fakeLocalSubscription(organizationId: string): Subscription {
  return { organizationId, plan: 'FREE', status: 'ACTIVE', billingInterval: null, seatCount: 1, cancelAtPeriodEnd: false };
}

interface FakeRepo extends WebhookSubscriptionRepo {
  updateFromStripeCalls: Parameters<WebhookSubscriptionRepo['updateFromStripe']>[0][];
  revertToFreeCalls: string[];
  setStatusCalls: { organizationId: string; status: string }[];
}

function buildFakeRepo(customerToOrg: Record<string, string>): FakeRepo {
  const updateFromStripeCalls: Parameters<WebhookSubscriptionRepo['updateFromStripe']>[0][] = [];
  const revertToFreeCalls: string[] = [];
  const setStatusCalls: { organizationId: string; status: string }[] = [];
  return {
    updateFromStripeCalls,
    revertToFreeCalls,
    setStatusCalls,
    findByStripeCustomerId: async (customerId) => {
      const organizationId = customerToOrg[customerId];
      return organizationId ? fakeLocalSubscription(organizationId) : undefined;
    },
    updateFromStripe: async (input) => {
      updateFromStripeCalls.push(input);
    },
    revertToFree: async (organizationId) => {
      revertToFreeCalls.push(organizationId);
    },
    setStatus: async (organizationId, status) => {
      setStatusCalls.push({ organizationId, status });
    },
  };
}

function fakeStripeSubscription(overrides: Partial<Stripe.Subscription> & { items: { price: string; quantity?: number }[] }): Stripe.Subscription {
  const { items, ...rest } = overrides;
  return {
    id: 'sub_123',
    customer: 'cus_123',
    status: 'active',
    current_period_end: 1_700_000_000,
    cancel_at_period_end: false,
    ...rest,
    // Spread LAST — `rest` must never clobber the {data: [...]} shape built here with the raw `items` array callers pass in.
    items: { data: items.map((item, i) => ({ id: `si_${i}`, price: { id: item.price }, quantity: item.quantity ?? 1 })) },
  } as unknown as Stripe.Subscription;
}

function fakeEvent(type: string, object: unknown): Stripe.Event {
  return { id: `evt_${Math.random()}`, type, data: { object } } as unknown as Stripe.Event;
}

describe('handleStripeWebhookEvent — checkout.session.completed', () => {
  it('retrieves the subscription and upserts the resolved plan', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const subscription = fakeStripeSubscription({ items: [{ price: 'price_pro_month' }] });
    const event = fakeEvent('checkout.session.completed', { subscription: 'sub_123' });

    await handleStripeWebhookEvent(event, { subscriptionRepo: repo, retrieveSubscription: async () => subscription });

    assert.equal(repo.updateFromStripeCalls.length, 1);
    assert.equal(repo.updateFromStripeCalls[0].organizationId, 'org-1');
    assert.equal(repo.updateFromStripeCalls[0].plan, 'PRO');
    assert.equal(repo.updateFromStripeCalls[0].status, 'ACTIVE');
    assert.equal(repo.updateFromStripeCalls[0].seatCount, 1);
  });

  it('does nothing when the session has no subscription', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const event = fakeEvent('checkout.session.completed', { subscription: null });
    await handleStripeWebhookEvent(event, { subscriptionRepo: repo, retrieveSubscription: async () => { throw new Error('should not be called'); } });
    assert.equal(repo.updateFromStripeCalls.length, 0);
  });
});

describe('handleStripeWebhookEvent — customer.subscription.updated', () => {
  it('computes TEAM seat count as includedSeats + the seat add-on item quantity', async () => {
    const repo = buildFakeRepo({ cus_team: 'org-team' });
    const subscription = fakeStripeSubscription({
      customer: 'cus_team',
      items: [{ price: 'price_team_month' }, { price: 'price_team_seat', quantity: 2 }],
    });
    const event = fakeEvent('customer.subscription.updated', subscription);

    await handleStripeWebhookEvent(event, { subscriptionRepo: repo, retrieveSubscription: async () => { throw new Error('unused'); } });

    assert.equal(repo.updateFromStripeCalls[0].plan, 'TEAM');
    assert.equal(repo.updateFromStripeCalls[0].seatCount, 5); // 3 included + 2 extra
  });

  it('ignores an event for a Stripe customer with no matching local subscription', async () => {
    const repo = buildFakeRepo({});
    const subscription = fakeStripeSubscription({ items: [{ price: 'price_pro_month' }] });
    const event = fakeEvent('customer.subscription.updated', subscription);

    await handleStripeWebhookEvent(event, { subscriptionRepo: repo, retrieveSubscription: async () => { throw new Error('unused'); } });
    assert.equal(repo.updateFromStripeCalls.length, 0);
  });

  it('ignores an event whose price id matches no configured plan', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const subscription = fakeStripeSubscription({ items: [{ price: 'price_unknown' }] });
    const event = fakeEvent('customer.subscription.updated', subscription);

    await handleStripeWebhookEvent(event, { subscriptionRepo: repo, retrieveSubscription: async () => { throw new Error('unused'); } });
    assert.equal(repo.updateFromStripeCalls.length, 0);
  });

  it('maps past_due/unpaid to PAST_DUE and trialing to TRIALING', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const pastDue = fakeStripeSubscription({ items: [{ price: 'price_pro_month' }], status: 'past_due' });
    await handleStripeWebhookEvent(fakeEvent('customer.subscription.updated', pastDue), { subscriptionRepo: repo, retrieveSubscription: async () => { throw new Error('unused'); } });
    assert.equal(repo.updateFromStripeCalls[0].status, 'PAST_DUE');
  });
});

describe('handleStripeWebhookEvent — customer.subscription.deleted', () => {
  it('reverts the matched organization to FREE', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const subscription = fakeStripeSubscription({ items: [{ price: 'price_pro_month' }] });
    await handleStripeWebhookEvent(fakeEvent('customer.subscription.deleted', subscription), { subscriptionRepo: repo, retrieveSubscription: async () => { throw new Error('unused'); } });
    assert.deepEqual(repo.revertToFreeCalls, ['org-1']);
  });
});

describe('handleStripeWebhookEvent — invoices', () => {
  it('invoice.payment_failed sets status PAST_DUE for a subscription invoice', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const invoice = { customer: 'cus_123', subscription: 'sub_123' } as unknown as Stripe.Invoice;
    await handleStripeWebhookEvent(fakeEvent('invoice.payment_failed', invoice), { subscriptionRepo: repo, retrieveSubscription: async () => { throw new Error('unused'); } });
    assert.deepEqual(repo.setStatusCalls, [{ organizationId: 'org-1', status: 'PAST_DUE' }]);
  });

  it('invoice.payment_succeeded sets status ACTIVE', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const invoice = { customer: 'cus_123', subscription: 'sub_123' } as unknown as Stripe.Invoice;
    await handleStripeWebhookEvent(fakeEvent('invoice.payment_succeeded', invoice), { subscriptionRepo: repo, retrieveSubscription: async () => { throw new Error('unused'); } });
    assert.deepEqual(repo.setStatusCalls, [{ organizationId: 'org-1', status: 'ACTIVE' }]);
  });

  it('ignores a non-subscription invoice', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const invoice = { customer: 'cus_123', subscription: null } as unknown as Stripe.Invoice;
    await handleStripeWebhookEvent(fakeEvent('invoice.payment_failed', invoice), { subscriptionRepo: repo, retrieveSubscription: async () => { throw new Error('unused'); } });
    assert.equal(repo.setStatusCalls.length, 0);
  });
});

function fakeStripeClient(customerEmails: Record<string, string | undefined>): Stripe {
  return {
    customers: {
      retrieve: async (id: string) => {
        const email = customerEmails[id];
        return email === undefined ? { id, deleted: true } : { id, deleted: false, email };
      },
    },
  } as unknown as Stripe;
}

describe('handleStripeWebhookEvent — billing notification emails', () => {
  it('sends billing-subscription-started only for checkout.session.completed, resolving the email from Stripe', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const subscription = fakeStripeSubscription({ items: [{ price: 'price_pro_month' }] });
    const event = fakeEvent('checkout.session.completed', { subscription: 'sub_123' });
    const sent: { to: string; plan: string; seatCount?: number }[] = [];

    await handleStripeWebhookEvent(event, {
      subscriptionRepo: repo,
      retrieveSubscription: async () => subscription,
      getStripe: () => fakeStripeClient({ cus_123: 'jane@example.com' }),
      webAppBaseUrl: 'http://localhost:5173',
      sendBillingSubscriptionStartedEmail: async (to, data) => { sent.push({ to, plan: data.plan, seatCount: data.seatCount }); },
    });

    assert.deepEqual(sent, [{ to: 'jane@example.com', plan: 'PRO', seatCount: 1 }]);
  });

  it('does NOT send a subscription-started email for customer.subscription.updated (would spam on every renewal/seat change)', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const subscription = fakeStripeSubscription({ items: [{ price: 'price_pro_month' }] });
    const event = fakeEvent('customer.subscription.updated', subscription);
    const sent: unknown[] = [];

    await handleStripeWebhookEvent(event, {
      subscriptionRepo: repo,
      retrieveSubscription: async () => { throw new Error('unused'); },
      getStripe: () => fakeStripeClient({ cus_123: 'jane@example.com' }),
      webAppBaseUrl: 'http://localhost:5173',
      sendBillingSubscriptionStartedEmail: async (to, data) => { sent.push({ to, data }); },
    });

    assert.equal(sent.length, 0);
  });

  it('sends billing-subscription-cancelled with the PREVIOUS plan (read before reverting to FREE)', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    repo.findByStripeCustomerId = async (id) => (id === 'cus_123' ? { organizationId: 'org-1', plan: 'TEAM', status: 'ACTIVE', billingInterval: 'MONTHLY', seatCount: 3, cancelAtPeriodEnd: false } : undefined);
    const subscription = fakeStripeSubscription({ items: [{ price: 'price_pro_month' }] });
    const sent: { to: string; plan: string }[] = [];

    await handleStripeWebhookEvent(fakeEvent('customer.subscription.deleted', subscription), {
      subscriptionRepo: repo,
      retrieveSubscription: async () => { throw new Error('unused'); },
      getStripe: () => fakeStripeClient({ cus_123: 'jane@example.com' }),
      webAppBaseUrl: 'http://localhost:5173',
      sendBillingSubscriptionCancelledEmail: async (to, data) => { sent.push({ to, plan: data.plan }); },
    });

    assert.deepEqual(sent, [{ to: 'jane@example.com', plan: 'TEAM' }]);
  });

  it('sends billing-payment-successful for invoice.payment_succeeded', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const invoice = { customer: 'cus_123', subscription: 'sub_123', amount_paid: 4900, currency: 'usd' } as unknown as Stripe.Invoice;
    const sent: { to: string; amount?: string }[] = [];

    await handleStripeWebhookEvent(fakeEvent('invoice.payment_succeeded', invoice), {
      subscriptionRepo: repo,
      retrieveSubscription: async () => { throw new Error('unused'); },
      getStripe: () => fakeStripeClient({ cus_123: 'jane@example.com' }),
      webAppBaseUrl: 'http://localhost:5173',
      sendBillingPaymentSuccessfulEmail: async (to, data) => { sent.push({ to, amount: data.amount }); },
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'jane@example.com');
    assert.equal(sent[0].amount, '$49.00');
  });

  it('sends billing-payment-failed for invoice.payment_failed', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const invoice = { customer: 'cus_123', subscription: 'sub_123' } as unknown as Stripe.Invoice;
    const sent: string[] = [];

    await handleStripeWebhookEvent(fakeEvent('invoice.payment_failed', invoice), {
      subscriptionRepo: repo,
      retrieveSubscription: async () => { throw new Error('unused'); },
      getStripe: () => fakeStripeClient({ cus_123: 'jane@example.com' }),
      webAppBaseUrl: 'http://localhost:5173',
      sendBillingPaymentFailedEmail: async (to) => { sent.push(to); },
    });

    assert.deepEqual(sent, ['jane@example.com']);
  });

  it('never throws and sends nothing when the Stripe customer has no email (e.g. deleted)', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const invoice = { customer: 'cus_123', subscription: 'sub_123' } as unknown as Stripe.Invoice;
    let called = false;

    await assert.doesNotReject(() =>
      handleStripeWebhookEvent(fakeEvent('invoice.payment_succeeded', invoice), {
        subscriptionRepo: repo,
        retrieveSubscription: async () => { throw new Error('unused'); },
        getStripe: () => fakeStripeClient({}),
        webAppBaseUrl: 'http://localhost:5173',
        sendBillingPaymentSuccessfulEmail: async () => { called = true; },
      }),
    );
    assert.equal(called, false);
  });

  it('still updates the DB even when the notification email send fails', async () => {
    const repo = buildFakeRepo({ cus_123: 'org-1' });
    const invoice = { customer: 'cus_123', subscription: 'sub_123' } as unknown as Stripe.Invoice;

    await handleStripeWebhookEvent(fakeEvent('invoice.payment_succeeded', invoice), {
      subscriptionRepo: repo,
      retrieveSubscription: async () => { throw new Error('unused'); },
      getStripe: () => fakeStripeClient({ cus_123: 'jane@example.com' }),
      webAppBaseUrl: 'http://localhost:5173',
      sendBillingPaymentSuccessfulEmail: async () => { throw new Error('SMTP down'); },
    });

    assert.deepEqual(repo.setStatusCalls, [{ organizationId: 'org-1', status: 'ACTIVE' }]);
  });
});

describe('handleStripeWebhookEvent — unhandled types', () => {
  it('resolves without error for an event type it does not handle', async () => {
    const repo = buildFakeRepo({});
    await assert.doesNotReject(() =>
      handleStripeWebhookEvent(fakeEvent('payment_intent.succeeded', {}), { subscriptionRepo: repo, retrieveSubscription: async () => { throw new Error('unused'); } }),
    );
  });
});
