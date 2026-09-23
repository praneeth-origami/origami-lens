/**
 * A Fastify preHandler factory with the same shape as auth-middleware.ts's
 * requireAuth — always run AFTER auth in a route's preHandler array (e.g.
 * `preHandler: [authMiddleware.requireAuth, usageLimit.requireQuota('INSPECTION')]`),
 * since a quota can only be checked against a resolved organization.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UsageMetric } from '@origami/contracts';
import type { EntitlementService } from './entitlement-service.js';
import { nextUsageResetAt } from './entitlement-service.js';

export interface UsageLimitMiddleware {
  requireQuota(metric: UsageMetric, resolveOrganizationId: (request: FastifyRequest) => Promise<string | undefined>): (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;
}

export function createUsageLimitMiddleware(entitlementService: EntitlementService): UsageLimitMiddleware {
  return {
    requireQuota(metric, resolveOrganizationId) {
      return async (request, reply) => {
        const organizationId = await resolveOrganizationId(request);
        // No organization to meter against (shouldn't happen once a route
        // requires auth first, but fail closed rather than silently allow).
        if (!organizationId) {
          reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
          return;
        }

        const result = await entitlementService.checkAndConsumeQuota(organizationId, metric);
        if (!result.allowed) {
          reply.status(402).send({
            error: `Daily limit reached for your plan (${result.limit} ${metric.toLowerCase().replace(/_/g, ' ')}/day). Upgrade to continue.`,
            errorCode: 'USAGE_LIMIT_EXCEEDED',
            limit: result.limit,
            remaining: result.remaining,
            plan: result.plan,
            resetAt: nextUsageResetAt(),
          });
        }
      };
    },
  };
}
