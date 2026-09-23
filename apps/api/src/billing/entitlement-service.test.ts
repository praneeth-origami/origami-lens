import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Subscription, SubscriptionPlan } from '@origami/contracts';
import { EntitlementService } from './entitlement-service.js';

function fakeSubscription(plan: SubscriptionPlan, seatCount = 1): Subscription {
  return { organizationId: 'org-1', plan, status: 'ACTIVE', billingInterval: plan === 'FREE' ? null : 'MONTHLY', seatCount, cancelAtPeriodEnd: false };
}

function buildService(plan: SubscriptionPlan, opts: { seatCount?: number; membersCount?: number } = {}) {
  const consumeCalls: unknown[] = [];
  const counts = new Map<string, number>();
  return {
    consumeCalls,
    service: new EntitlementService({
      subscriptionRepo: { getOrCreateForOrganization: async () => fakeSubscription(plan, opts.seatCount ?? 1) },
      usageCounterRepo: {
        tryConsume: async (organizationId, metric, usageDate, limit) => {
          consumeCalls.push({ organizationId, metric, usageDate, limit });
          const key = `${organizationId}:${metric}:${usageDate}`;
          const next = (counts.get(key) ?? 0) + 1;
          if (next > limit) return { allowed: false, count: counts.get(key) ?? 0 };
          counts.set(key, next);
          return { allowed: true, count: next };
        },
        getCount: async (organizationId, metric, usageDate) => counts.get(`${organizationId}:${metric}:${usageDate}`) ?? 0,
      },
      organizationRepo: { countMembers: async () => opts.membersCount ?? 1 },
    }),
  };
}

describe('EntitlementService — getEntitlements', () => {
  it('resolves the FREE plan limits from PLAN_DEFINITIONS', async () => {
    const { service } = buildService('FREE');
    const entitlements = await service.getEntitlements('org-1');
    assert.equal(entitlements.plan, 'FREE');
    assert.equal(entitlements.limits.inspectionsPerDay, 5);
  });

  it('an unlimited plan (TEAM) has null limits', async () => {
    const { service } = buildService('TEAM');
    const entitlements = await service.getEntitlements('org-1');
    assert.equal(entitlements.limits.inspectionsPerDay, null);
    assert.equal(entitlements.limits.aiQuestionsPerDay, null);
    assert.equal(entitlements.limits.screenshotToCodePerDay, null);
  });

  it('seatsIncluded comes from the subscription row, seatsUsed from organization membership count', async () => {
    const { service } = buildService('TEAM', { seatCount: 5, membersCount: 3 });
    const entitlements = await service.getEntitlements('org-1');
    assert.equal(entitlements.seatsIncluded, 5);
    assert.equal(entitlements.seatsUsed, 3);
  });
});

describe('EntitlementService — checkAndConsumeQuota', () => {
  it('an unlimited plan is always allowed and never touches the usage counter', async () => {
    const { service, consumeCalls } = buildService('TEAM');
    const result = await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    assert.equal(result.allowed, true);
    assert.equal(result.limit, null);
    assert.equal(result.remaining, null);
    assert.equal(result.plan, 'TEAM');
    assert.equal(consumeCalls.length, 0);
  });

  it('allows exactly `limit` calls then denies the next one, for a limited plan (FREE: 5 inspections/day)', async () => {
    const { service } = buildService('FREE');
    for (let i = 1; i <= 5; i++) {
      const result = await service.checkAndConsumeQuota('org-1', 'INSPECTION');
      assert.equal(result.allowed, true, `call ${i} should be allowed`);
      assert.equal(result.remaining, 5 - i);
    }
    const sixth = await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    assert.equal(sixth.allowed, false);
    assert.equal(sixth.remaining, 0);
  });

  it('different metrics are tracked independently', async () => {
    const { service } = buildService('FREE');
    for (let i = 0; i < 5; i++) await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    const denied = await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    assert.equal(denied.allowed, false);

    // AI_QUESTION quota (also 5/day on FREE) is untouched by INSPECTION usage.
    const aiResult = await service.checkAndConsumeQuota('org-1', 'AI_QUESTION');
    assert.equal(aiResult.allowed, true);
    assert.equal(aiResult.remaining, 4);
  });
});

interface NotificationTestOpts {
  members?: { userId: string; email?: string; role: 'OWNER' | 'MEMBER'; displayName?: string; joinedAt: string }[];
  claimResult?: boolean | (() => boolean);
  sendImpl?: (to: string, data: { plan: string; resource?: string; resetAt?: string; webAppBaseUrl: string }) => Promise<void>;
  omitSend?: boolean;
}

function buildServiceForNotificationTests(opts: NotificationTestOpts = {}) {
  const counts = new Map<string, number>();
  const claimCalls: unknown[] = [];
  const sent: { to: string; data: { plan: string; resource?: string; resetAt?: string; webAppBaseUrl: string } }[] = [];
  const members = opts.members ?? [{ userId: 'owner-1', email: 'owner@example.com', role: 'OWNER' as const, joinedAt: new Date().toISOString() }];

  const service = new EntitlementService({
    subscriptionRepo: { getOrCreateForOrganization: async () => ({ organizationId: 'org-1', plan: 'FREE', status: 'ACTIVE', billingInterval: null, seatCount: 1, cancelAtPeriodEnd: false }) },
    usageCounterRepo: {
      tryConsume: async (organizationId, metric, usageDate, limit) => {
        const key = `${organizationId}:${metric}:${usageDate}`;
        const next = (counts.get(key) ?? 0) + 1;
        if (next > limit) return { allowed: false, count: counts.get(key) ?? 0 };
        counts.set(key, next);
        return { allowed: true, count: next };
      },
      getCount: async (organizationId, metric, usageDate) => counts.get(`${organizationId}:${metric}:${usageDate}`) ?? 0,
      claimLimitReachedNotification: async (...args) => {
        claimCalls.push(args);
        return typeof opts.claimResult === 'function' ? opts.claimResult() : opts.claimResult ?? true;
      },
    },
    organizationRepo: { countMembers: async () => members.length, listMembers: async () => members },
    ...(opts.omitSend
      ? {}
      : {
          sendBillingPlanLimitReachedEmail: opts.sendImpl ?? (async (to, data) => { sent.push({ to, data }); }),
          webAppBaseUrl: 'http://localhost:5173',
        }),
  });

  return { service, claimCalls, sent };
}

describe('EntitlementService — plan-limit-reached notification', () => {
  it('sends the email to the org OWNER exactly on the rejected call (not on any allowed call)', async () => {
    const { service, sent } = buildServiceForNotificationTests();
    for (let i = 0; i < 5; i++) await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    assert.equal(sent.length, 0);

    await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'owner@example.com');
    assert.equal(sent[0].data.plan, 'FREE');
    assert.equal(sent[0].data.resource, 'Scans');
    assert.ok(sent[0].data.resetAt);
  });

  it('does not send a second email for a later rejection the same day (claim already taken)', async () => {
    let claimed = false;
    const { service, sent } = buildServiceForNotificationTests({ claimResult: () => (claimed ? false : ((claimed = true), true)) });
    for (let i = 0; i < 5; i++) await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    assert.equal(sent.length, 1);
  });

  it('sends nothing when the claim was already taken by another request today', async () => {
    const { service, sent } = buildServiceForNotificationTests({ claimResult: false });
    for (let i = 0; i < 5; i++) await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    assert.equal(sent.length, 0);
  });

  it('sends nothing when no OWNER member has an email on file', async () => {
    const { service, sent } = buildServiceForNotificationTests({ members: [{ userId: 'owner-1', role: 'OWNER', joinedAt: new Date().toISOString() }] });
    for (let i = 0; i < 5; i++) await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    assert.equal(sent.length, 0);
  });

  it('sends nothing when sendBillingPlanLimitReachedEmail/webAppBaseUrl are omitted (existing behavior preserved)', async () => {
    const { service, sent, claimCalls } = buildServiceForNotificationTests({ omitSend: true });
    for (let i = 0; i < 5; i++) await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    assert.equal(sent.length, 0);
    assert.equal(claimCalls.length, 0); // never even attempts the claim when notifications aren't configured
  });

  it('never throws and still returns the correct denial when the email send fails', async () => {
    const { service } = buildServiceForNotificationTests({ sendImpl: async () => { throw new Error('SMTP down'); } });
    for (let i = 0; i < 5; i++) await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    const result = await service.checkAndConsumeQuota('org-1', 'INSPECTION');
    assert.equal(result.allowed, false);
  });
});
