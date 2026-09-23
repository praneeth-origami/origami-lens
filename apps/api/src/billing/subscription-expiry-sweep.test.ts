import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Subscription, WorkspaceMember } from '@origami/contracts';
import { sweepExpiringSubscriptions, type SubscriptionExpirySweepDeps } from './subscription-expiry-sweep.js';

function fakeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    organizationId: 'org-1',
    plan: 'TEAM',
    status: 'ACTIVE',
    billingInterval: 'MONTHLY',
    seatCount: 3,
    currentPeriodEnd: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    cancelAtPeriodEnd: true,
    ...overrides,
  };
}

function fakeOwner(email = 'owner@example.com'): WorkspaceMember {
  return { userId: 'owner-1', email, role: 'OWNER', joinedAt: new Date().toISOString() };
}

interface BuildOpts {
  candidates?: Subscription[];
  members?: WorkspaceMember[];
  claimResult?: boolean | ((organizationId: string) => boolean);
  sendImpl?: (to: string, data: { plan: string; currentPeriodEnd: string; webAppBaseUrl: string }) => Promise<void>;
}

function buildDeps(opts: BuildOpts = {}) {
  const sent: { to: string; data: { plan: string; currentPeriodEnd: string; webAppBaseUrl: string } }[] = [];
  const claimCalls: { organizationId: string; withinDays: number }[] = [];
  const candidates = opts.candidates ?? [fakeSubscription()];
  const members = opts.members ?? [fakeOwner()];

  const deps: SubscriptionExpirySweepDeps = {
    subscriptionRepo: {
      findExpiringSoon: async () => candidates,
      claimExpiringSoonNotification: async (organizationId, withinDays) => {
        claimCalls.push({ organizationId, withinDays });
        const won = typeof opts.claimResult === 'function' ? opts.claimResult(organizationId) : opts.claimResult ?? true;
        if (!won) return undefined;
        const subscription = candidates.find((c) => c.organizationId === organizationId);
        return { currentPeriodEnd: subscription?.currentPeriodEnd ?? new Date().toISOString() };
      },
    },
    organizationRepo: { listMembers: async () => members },
    sendBillingPlanExpiringSoonEmail: opts.sendImpl ?? (async (to, data) => { sent.push({ to, data }); }),
    webAppBaseUrl: 'http://localhost:5173',
  };

  return { deps, sent, claimCalls };
}

describe('sweepExpiringSubscriptions', () => {
  it('sends to the OWNER for each claimed candidate and reports the count', async () => {
    const { deps, sent } = buildDeps();
    const count = await sweepExpiringSubscriptions(deps);
    assert.equal(count, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'owner@example.com');
    assert.equal(sent[0].data.plan, 'TEAM');
  });

  it('skips a candidate whose notification was already claimed by an earlier tick', async () => {
    const { deps, sent, claimCalls } = buildDeps({ claimResult: false });
    const count = await sweepExpiringSubscriptions(deps);
    assert.equal(count, 0);
    assert.equal(sent.length, 0);
    assert.equal(claimCalls.length, 1); // still attempted the claim
  });

  it('skips a candidate whose organization has no OWNER with an email on file', async () => {
    const { deps, sent } = buildDeps({ members: [{ userId: 'owner-1', role: 'OWNER', joinedAt: new Date().toISOString() }] });
    const count = await sweepExpiringSubscriptions(deps);
    assert.equal(count, 0);
    assert.equal(sent.length, 0);
  });

  it('processes multiple candidates independently — one failing send never blocks the others', async () => {
    const candidates = [
      fakeSubscription({ organizationId: 'org-1', currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString() }),
      fakeSubscription({ organizationId: 'org-2', currentPeriodEnd: new Date(Date.now() + 172_800_000).toISOString() }),
    ];
    let calls = 0;
    const { deps, sent } = buildDeps({
      candidates,
      sendImpl: async (to, data) => {
        calls += 1;
        if (calls === 1) throw new Error('SMTP down');
        sent.push({ to, data });
      },
    });
    const count = await sweepExpiringSubscriptions(deps);
    assert.equal(count, 1); // the second one still went through
    assert.equal(sent.length, 1);
  });

  it('uses the currentPeriodEnd returned by the claim (the live DB value), not a stale candidate field', async () => {
    const staleEnd = new Date(Date.now() + 1_000).toISOString();
    const authoritativeEnd = new Date(Date.now() + 999_999).toISOString();
    const { deps, sent } = buildDeps({
      candidates: [fakeSubscription({ currentPeriodEnd: staleEnd })],
    });
    // Override the claim to return a different (more authoritative) value than the candidate's own field.
    deps.subscriptionRepo.claimExpiringSoonNotification = async () => ({ currentPeriodEnd: authoritativeEnd });
    await sweepExpiringSubscriptions(deps);
    assert.equal(sent[0].data.currentPeriodEnd, authoritativeEnd);
  });

  it('returns 0 without touching anything when there are no candidates', async () => {
    const { deps, sent, claimCalls } = buildDeps({ candidates: [] });
    const count = await sweepExpiringSubscriptions(deps);
    assert.equal(count, 0);
    assert.equal(sent.length, 0);
    assert.equal(claimCalls.length, 0);
  });
});
