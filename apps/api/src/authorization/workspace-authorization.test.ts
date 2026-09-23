import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OrganizationRole } from '@origami/contracts';
import { assertWorkspaceRole, getWorkspaceRoleOrThrow, WorkspaceAuthorizationError, type WorkspaceRoleRepo } from './workspace-authorization.js';
import { createWorkspaceRoleMiddleware } from './workspace-role-middleware.js';

function fakeRepo(role: OrganizationRole | undefined): WorkspaceRoleRepo {
  return { getMembershipRole: async () => role };
}

describe('assertWorkspaceRole', () => {
  it('resolves without throwing when the permission function allows the resolved role', async () => {
    await assert.doesNotReject(() => assertWorkspaceRole(fakeRepo('OWNER'), 'user-1', 'org-1', (role) => role === 'OWNER'));
  });

  it('throws WorkspaceAuthorizationError when the permission function denies the resolved role', async () => {
    await assert.rejects(
      () => assertWorkspaceRole(fakeRepo('MEMBER'), 'user-1', 'org-1', (role) => role === 'OWNER'),
      WorkspaceAuthorizationError,
    );
  });

  it('throws when the caller has no membership at all (role undefined)', async () => {
    await assert.rejects(
      () => assertWorkspaceRole(fakeRepo(undefined), 'user-1', 'org-1', (role) => role !== undefined),
      WorkspaceAuthorizationError,
    );
  });
});

describe('getWorkspaceRoleOrThrow', () => {
  it('returns the real role when a membership exists', async () => {
    assert.equal(await getWorkspaceRoleOrThrow(fakeRepo('ADMIN'), 'user-1', 'org-1'), 'ADMIN');
  });

  it('throws when there is no membership', async () => {
    await assert.rejects(() => getWorkspaceRoleOrThrow(fakeRepo(undefined), 'user-1', 'org-1'), WorkspaceAuthorizationError);
  });
});

describe('createWorkspaceRoleMiddleware — the Fastify preHandler used on every gated route', () => {
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

  it('rejects with 401 when the organization resolver returns undefined (no authenticated org context)', async () => {
    const middleware = createWorkspaceRoleMiddleware(fakeRepo('OWNER'));
    const handler = middleware.requireRole(() => true, async () => undefined);
    const { reply, calls } = fakeReply();

    await handler({ user: { id: 'user-1' } } as unknown as import('fastify').FastifyRequest, reply);

    assert.equal(calls.status, 401);
    assert.equal((calls.body as { errorCode: string }).errorCode, 'UNAUTHENTICATED');
  });

  it('rejects with 403 when the resolved role fails the permission check', async () => {
    const middleware = createWorkspaceRoleMiddleware(fakeRepo('VIEWER'));
    const handler = middleware.requireRole((role) => role === 'OWNER' || role === 'ADMIN', async () => 'org-1');
    const { reply, calls } = fakeReply();

    await handler({ user: { id: 'user-1' } } as unknown as import('fastify').FastifyRequest, reply);

    assert.equal(calls.status, 403);
    assert.equal((calls.body as { errorCode: string }).errorCode, 'FORBIDDEN');
  });

  it('allows the request through (never calls reply) when the role passes the permission check', async () => {
    const middleware = createWorkspaceRoleMiddleware(fakeRepo('OWNER'));
    const handler = middleware.requireRole((role) => role === 'OWNER', async () => 'org-1');
    const { reply, calls } = fakeReply();

    await handler({ user: { id: 'user-1' } } as unknown as import('fastify').FastifyRequest, reply);

    assert.equal(calls.status, undefined);
    assert.equal(calls.body, undefined);
  });
});
