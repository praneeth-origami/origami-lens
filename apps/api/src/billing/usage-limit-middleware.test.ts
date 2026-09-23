import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Subscription } from '@origami/contracts';
import { PLAN_DEFINITIONS } from '@origami/contracts';
import { EntitlementService } from './entitlement-service.js';
import { createUsageLimitMiddleware } from './usage-limit-middleware.js';

const FREE_INSPECTIONS_PER_DAY = PLAN_DEFINITIONS.FREE.limits.inspectionsPerDay!;

function fakeFreeSubscription(): Subscription {
  return { organizationId: 'org-1', plan: 'FREE', status: 'ACTIVE', billingInterval: null, seatCount: 1, cancelAtPeriodEnd: false };
}

/** Minimal fake Fastify reply — just enough of the chainable status().send() shape the middleware calls. */
function fakeReply() {
  const calls: { status?: number; body?: unknown } = {};
  return {
    calls,
    reply: {
      status(code: number) {
        calls.status = code;
        return this;
      },
      send(body: unknown) {
        calls.body = body;
        return this;
      },
    } as unknown as import('fastify').FastifyReply,
  };
}

/** subscriptionRepo always resolves FREE, so the real limit enforced is PLAN_DEFINITIONS.FREE (5/day for INSPECTION) — the fake tryConsume below honors whatever limit EntitlementService passes it, exactly like the real usage-counter-repository does, so these tests exercise the real plan-limit resolution rather than an arbitrary test-only number. */
function buildMiddleware() {
  let count = 0;
  const service = new EntitlementService({
    subscriptionRepo: { getOrCreateForOrganization: async () => fakeFreeSubscription() },
    usageCounterRepo: {
      tryConsume: async (_organizationId, _metric, _usageDate, limit) => {
        count += 1;
        return count <= limit ? { allowed: true, count } : { allowed: false, count: limit };
      },
      getCount: async () => count,
    },
    organizationRepo: { countMembers: async () => 1 },
  });
  return createUsageLimitMiddleware(service);
}

describe('usage-limit-middleware — requireQuota', () => {
  it('rejects with 401 when no organization can be resolved (no authenticated user)', async () => {
    const middleware = buildMiddleware();
    const handler = middleware.requireQuota('INSPECTION', async () => undefined);
    const { reply, calls } = fakeReply();

    await handler({} as unknown as import('fastify').FastifyRequest, reply);

    assert.equal(calls.status, 401);
    assert.equal((calls.body as { errorCode: string }).errorCode, 'UNAUTHENTICATED');
  });

  it('allows requests under the limit and sends nothing (does not short-circuit the route)', async () => {
    const middleware = buildMiddleware();
    const handler = middleware.requireQuota('INSPECTION', async () => 'org-1');
    const { reply, calls } = fakeReply();

    await handler({} as unknown as import('fastify').FastifyRequest, reply);

    assert.equal(calls.status, undefined);
    assert.equal(calls.body, undefined);
  });

  it('denies with 402 USAGE_LIMIT_EXCEEDED once the FREE plan limit is reached', async () => {
    const middleware = buildMiddleware();
    const handler = middleware.requireQuota('INSPECTION', async () => 'org-1');

    for (let i = 0; i < FREE_INSPECTIONS_PER_DAY; i++) {
      const { reply, calls } = fakeReply();
      await handler({} as unknown as import('fastify').FastifyRequest, reply);
      assert.equal(calls.status, undefined, `call ${i + 1} should be allowed`);
    }

    const denied = fakeReply();
    await handler({} as unknown as import('fastify').FastifyRequest, denied.reply);
    assert.equal(denied.calls.status, 402);
    assert.equal((denied.calls.body as { errorCode: string }).errorCode, 'USAGE_LIMIT_EXCEEDED');
    assert.equal((denied.calls.body as { limit: number }).limit, FREE_INSPECTIONS_PER_DAY);
  });

  it('includes plan and resetAt on a 402 so the frontend restriction toast can show real numbers', async () => {
    const middleware = buildMiddleware();
    const handler = middleware.requireQuota('INSPECTION', async () => 'org-1');

    for (let i = 0; i < FREE_INSPECTIONS_PER_DAY; i++) {
      const { reply } = fakeReply();
      await handler({} as unknown as import('fastify').FastifyRequest, reply);
    }

    const denied = fakeReply();
    await handler({} as unknown as import('fastify').FastifyRequest, denied.reply);
    const body = denied.calls.body as { plan: string; resetAt: string };
    assert.equal(body.plan, 'FREE');
    assert.ok(!Number.isNaN(new Date(body.resetAt).getTime()), 'resetAt should be a valid ISO timestamp');
    assert.ok(new Date(body.resetAt).getTime() > Date.now(), 'resetAt should be in the future');
  });
});
