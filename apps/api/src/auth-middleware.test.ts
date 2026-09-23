import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthUser } from '@origami/contracts';
import { SESSION_COOKIE_NAME, createAuthMiddleware } from './auth-middleware.js';
import type { SessionRepository } from './db/session-repository.js';

function fakeUser(): AuthUser {
  return { id: 'user-1', primaryProvider: 'GITHUB', primaryProviderLogin: 'octocat' };
}

function fakeSessionRepo(overrides: Partial<SessionRepository>): SessionRepository {
  return {
    isEnabled: () => true,
    create: async () => {},
    getValidByIdAndTouch: async () => undefined,
    deleteById: async () => {},
    deleteExpired: async () => 0,
    ...overrides,
  } as SessionRepository;
}

function fakeRequest(cookies: Record<string, string> = {}): FastifyRequest {
  return { cookies } as unknown as FastifyRequest;
}

function fakeReply() {
  const calls: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) { calls.status = code; return reply; },
    send(body: unknown) { calls.body = body; return reply; },
  } as unknown as FastifyReply;
  return { reply, calls };
}

describe('auth-middleware — populateUser', () => {
  it('leaves request.user unset when there is no session cookie', async () => {
    const { populateUser } = createAuthMiddleware(fakeSessionRepo({}));
    const request = fakeRequest({});
    await populateUser(request);
    assert.equal(request.user, undefined);
  });

  it('leaves request.user unset when the session store is disabled (no DATABASE_URL)', async () => {
    const { populateUser } = createAuthMiddleware(fakeSessionRepo({ isEnabled: () => false, getValidByIdAndTouch: async () => { throw new Error('should not be called'); } }));
    const request = fakeRequest({ [SESSION_COOKIE_NAME]: 'session-1' });
    await populateUser(request);
    assert.equal(request.user, undefined);
  });

  it('leaves request.user unset when the cookie does not resolve to a valid session', async () => {
    const { populateUser } = createAuthMiddleware(fakeSessionRepo({ getValidByIdAndTouch: async () => undefined }));
    const request = fakeRequest({ [SESSION_COOKIE_NAME]: 'expired-or-unknown' });
    await populateUser(request);
    assert.equal(request.user, undefined);
  });

  it('populates request.user for a valid session cookie', async () => {
    const user = fakeUser();
    const { populateUser } = createAuthMiddleware(fakeSessionRepo({
      getValidByIdAndTouch: async (id) => (id === 'session-1' ? { sessionId: id, expiresAt: new Date().toISOString(), user } : undefined),
    }));
    const request = fakeRequest({ [SESSION_COOKIE_NAME]: 'session-1' });
    await populateUser(request);
    assert.equal(request.user?.id, 'user-1');
  });
});

describe('auth-middleware — requireAuth', () => {
  it('responds 401 UNAUTHENTICATED and never populates request.user when unauthenticated', async () => {
    const { requireAuth } = createAuthMiddleware(fakeSessionRepo({}));
    const request = fakeRequest({});
    const { reply, calls } = fakeReply();

    await requireAuth(request, reply);

    assert.equal(calls.status, 401);
    assert.equal((calls.body as { errorCode?: string })?.errorCode, 'UNAUTHENTICATED');
    assert.equal(request.user, undefined);
  });

  it('does not send a reply and sets request.user when authenticated', async () => {
    const user = fakeUser();
    const { requireAuth } = createAuthMiddleware(fakeSessionRepo({
      getValidByIdAndTouch: async () => ({ sessionId: 'session-1', expiresAt: new Date().toISOString(), user }),
    }));
    const request = fakeRequest({ [SESSION_COOKIE_NAME]: 'session-1' });
    const { reply, calls } = fakeReply();

    await requireAuth(request, reply);

    assert.equal(calls.status, undefined);
    assert.equal(request.user?.id, 'user-1');
  });
});
