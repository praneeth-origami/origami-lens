import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { createAuthMiddleware, SESSION_COOKIE_NAME } from './auth-middleware.js';
import { canMutateRepository, canReadWorkspaceResource } from './authorization/workspace-permissions.js';

/**
 * Proves the 404-vs-403 split the RBAC design depends on, end to end over
 * real HTTP with the real requireAuth (mirrors repository-http-ownership.test.ts's
 * harness style exactly): a caller who ISN'T a member of the resource's
 * organization at all gets 404 (never confirms the resource exists — same
 * convention as every pre-existing ownership check in this codebase); a
 * real member of that organization whose ROLE is insufficient gets 403
 * (they already know the resource/workspace exists, so there's nothing left
 * to hide). Only the small in-memory repo/membership maps are fake — the
 * auth middleware and the real workspace-permissions functions are not.
 */
type AuthUser = { id: string; primaryProvider: 'GITHUB'; primaryProviderLogin: string };
type SessionWithUser = { sessionId: string; expiresAt: string; user: AuthUser };
type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | 'CLIENT_VIEWER';

class FakeSessionRepository {
  private sessions = new Map<string, SessionWithUser>();
  isEnabled(): boolean {
    return true;
  }
  registerSession(sessionId: string, user: AuthUser): void {
    this.sessions.set(sessionId, { sessionId, expiresAt: new Date(Date.now() + 60_000).toISOString(), user });
  }
  async getValidByIdAndTouch(sessionId: string): Promise<SessionWithUser | undefined> {
    return this.sessions.get(sessionId);
  }
  async create(): Promise<void> {}
  async deleteById(): Promise<void> {}
  async deleteExpired(): Promise<number> {
    return 0;
  }
}

async function buildApp() {
  const sessionRepo = new FakeSessionRepository();
  const authMiddleware = createAuthMiddleware(sessionRepo as unknown as Parameters<typeof createAuthMiddleware>[0]);

  const repositories = new Map<string, { id: string; organizationId: string }>();
  const memberships = new Map<string, Map<string, Role>>();

  function organizationIdsForUser(userId: string): string[] {
    return [...memberships.entries()].filter(([, members]) => members.has(userId)).map(([orgId]) => orgId);
  }

  const app = Fastify();
  await app.register(cookie);

  app.post<{ Body: { organizationId: string } }>('/test/repositories', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
    const id = randomUUID();
    repositories.set(id, { id, organizationId: request.body.organizationId });
    return reply.status(201).send({ id });
  });

  // Mirrors the real production pattern exactly: (1) resource-organization
  // membership check -> 404 if the caller isn't in that org at all, (2)
  // real workspace-permissions role check -> 403 if membership exists but
  // the role is insufficient.
  app.post<{ Params: { id: string } }>('/test/repositories/:id/mutate', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
    const repository = repositories.get(request.params.id);
    if (!repository || !organizationIdsForUser(request.user!.id).includes(repository.organizationId)) {
      return reply.status(404).send({ error: 'Repository not found' });
    }
    const role = memberships.get(repository.organizationId)?.get(request.user!.id);
    if (!canMutateRepository(role)) {
      return reply.status(403).send({ error: 'Forbidden', errorCode: 'FORBIDDEN' });
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/test/repositories/:id', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
    const repository = repositories.get(request.params.id);
    if (!repository || !organizationIdsForUser(request.user!.id).includes(repository.organizationId)) {
      return reply.status(404).send({ error: 'Repository not found' });
    }
    const role = memberships.get(repository.organizationId)?.get(request.user!.id);
    if (!canReadWorkspaceResource(role)) {
      return reply.status(403).send({ error: 'Forbidden', errorCode: 'FORBIDDEN' });
    }
    return repository;
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { app, port, sessionRepo, memberships };
}

function registerUser(sessionRepo: FakeSessionRepository, login: string): { userId: string; cookieHeader: string } {
  const sessionId = randomUUID();
  const userId = randomUUID();
  sessionRepo.registerSession(sessionId, { id: userId, primaryProvider: 'GITHUB', primaryProviderLogin: login });
  return { userId, cookieHeader: `${SESSION_COOKIE_NAME}=${sessionId}` };
}

describe('Phase 18 — the 404-vs-403 authorization split (real requireAuth + real workspace-permissions)', () => {
  it('a caller with NO membership in the resource\'s organization at all gets 404, not 403 (never confirms existence)', async () => {
    const { app, port, sessionRepo, memberships } = await buildApp();
    try {
      const owner = registerUser(sessionRepo, 'owner');
      const outsider = registerUser(sessionRepo, 'outsider');
      const orgId = randomUUID();
      memberships.set(orgId, new Map([[owner.userId, 'OWNER']]));

      const createRes = await fetch(`http://127.0.0.1:${port}/test/repositories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: owner.cookieHeader },
        body: JSON.stringify({ organizationId: orgId }),
      });
      const { id } = (await createRes.json()) as { id: string };

      const res = await fetch(`http://127.0.0.1:${port}/test/repositories/${id}/mutate`, { method: 'POST', headers: { Cookie: outsider.cookieHeader } });
      assert.equal(res.status, 404);
    } finally {
      await app.close();
    }
  });

  it('a real member of the organization with an INSUFFICIENT role gets 403, not 404', async () => {
    const { app, port, sessionRepo, memberships } = await buildApp();
    try {
      const owner = registerUser(sessionRepo, 'owner');
      const viewer = registerUser(sessionRepo, 'viewer');
      const orgId = randomUUID();
      memberships.set(orgId, new Map([[owner.userId, 'OWNER'], [viewer.userId, 'VIEWER']]));

      const createRes = await fetch(`http://127.0.0.1:${port}/test/repositories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: owner.cookieHeader },
        body: JSON.stringify({ organizationId: orgId }),
      });
      const { id } = (await createRes.json()) as { id: string };

      const res = await fetch(`http://127.0.0.1:${port}/test/repositories/${id}/mutate`, { method: 'POST', headers: { Cookie: viewer.cookieHeader } });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { errorCode?: string };
      assert.equal(body.errorCode, 'FORBIDDEN');
    } finally {
      await app.close();
    }
  });

  it('a member with a sufficient role succeeds', async () => {
    const { app, port, sessionRepo, memberships } = await buildApp();
    try {
      const owner = registerUser(sessionRepo, 'owner');
      const admin = registerUser(sessionRepo, 'admin');
      const orgId = randomUUID();
      memberships.set(orgId, new Map([[owner.userId, 'OWNER'], [admin.userId, 'ADMIN']]));

      const createRes = await fetch(`http://127.0.0.1:${port}/test/repositories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: owner.cookieHeader },
        body: JSON.stringify({ organizationId: orgId }),
      });
      const { id } = (await createRes.json()) as { id: string };

      const res = await fetch(`http://127.0.0.1:${port}/test/repositories/${id}/mutate`, { method: 'POST', headers: { Cookie: admin.cookieHeader } });
      assert.equal(res.status, 200);
    } finally {
      await app.close();
    }
  });

  it('CLIENT_VIEWER is denied ordinary reads (403) even as a real member — fail-closed until real per-resource sharing exists', async () => {
    const { app, port, sessionRepo, memberships } = await buildApp();
    try {
      const owner = registerUser(sessionRepo, 'owner');
      const clientViewer = registerUser(sessionRepo, 'client-viewer');
      const orgId = randomUUID();
      memberships.set(orgId, new Map([[owner.userId, 'OWNER'], [clientViewer.userId, 'CLIENT_VIEWER']]));

      const createRes = await fetch(`http://127.0.0.1:${port}/test/repositories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: owner.cookieHeader },
        body: JSON.stringify({ organizationId: orgId }),
      });
      const { id } = (await createRes.json()) as { id: string };

      const res = await fetch(`http://127.0.0.1:${port}/test/repositories/${id}`, { headers: { Cookie: clientViewer.cookieHeader } });
      assert.equal(res.status, 403);
    } finally {
      await app.close();
    }
  });

  it('an unauthenticated caller gets 401, never reaching the 404/403 resource logic', async () => {
    const { app, port } = await buildApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/test/repositories/${randomUUID()}/mutate`, { method: 'POST' });
      assert.equal(res.status, 401);
    } finally {
      await app.close();
    }
  });
});
