/**
 * A Fastify preHandler factory with the same composable shape as
 * billing/usage-limit-middleware.ts's requireQuota — always run AFTER
 * authMiddleware.requireAuth (and typically BEFORE requireQuota, when both
 * apply to the same route) in a route's preHandler array, e.g.
 * `preHandler: [authMiddleware.requireAuth, workspaceRoleMiddleware.requireRole(canRunScanOrAI, resolveOrganizationIdForAuthenticatedRequest), usageLimitMiddleware.requireQuota(...)]`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OrganizationRole } from '@origami/contracts';
import type { WorkspaceRoleRepo } from './workspace-authorization.js';

export interface WorkspaceRoleMiddleware {
  requireRole(
    permission: (role: OrganizationRole | undefined) => boolean,
    resolveOrganizationId: (request: FastifyRequest) => Promise<string | undefined>,
  ): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export function createWorkspaceRoleMiddleware(repo: WorkspaceRoleRepo): WorkspaceRoleMiddleware {
  return {
    requireRole(permission, resolveOrganizationId) {
      return async (request, reply) => {
        const organizationId = await resolveOrganizationId(request);
        if (!organizationId) {
          reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
          return;
        }

        const role = await repo.getMembershipRole(organizationId, request.user!.id);
        if (!permission(role)) {
          reply.status(403).send({ error: 'You do not have permission to perform this action in this workspace.', errorCode: 'FORBIDDEN' });
        }
      };
    },
  };
}
