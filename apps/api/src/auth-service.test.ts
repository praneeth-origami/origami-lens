import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthUser } from '@origami/contracts';
import { AuthError, loginWithGitHub, logout, resolveSessionUser } from './auth-service.js';
import { GitHubOAuthError } from './auth-github-oauth.js';
import type { SessionWithUser } from './db/session-repository.js';

const originalTtl = process.env.SESSION_TTL_MS;
afterEach(() => {
  process.env.SESSION_TTL_MS = originalTtl;
});

function fakeUser(id: string): AuthUser {
  return { id, primaryProvider: 'GITHUB', primaryProviderLogin: 'octocat', email: 'octocat@example.com', displayName: 'The Octocat' };
}

describe('auth-service — loginWithGitHub', () => {
  it('upserts the user from the GitHub profile and creates a session for that user', async () => {
    const upsertCalls: unknown[] = [];
    const createCalls: unknown[] = [];
    const user = fakeUser('user-1');

    const result = await loginWithGitHub('code-abc', {
      userRepo: {
        upsertByProviderAccount: async (input) => { upsertCalls.push(input); return user; },
      },
      sessionRepo: {
        create: async (input) => { createCalls.push(input); },
        getValidByIdAndTouch: async () => undefined,
        deleteById: async () => {},
      },
      completeGitHubOAuthLogin: async () => ({ id: 999, login: 'octocat', email: 'octocat@example.com', name: 'The Octocat', avatarUrl: null }),
    });

    assert.equal(result.user.id, 'user-1');
    assert.equal(upsertCalls.length, 1);
    assert.deepEqual((upsertCalls[0] as { primaryProviderAccountId: string }).primaryProviderAccountId, '999');
    assert.equal(createCalls.length, 1);
    assert.equal((createCalls[0] as { userId: string }).userId, 'user-1');
    assert.ok(result.sessionId);
    assert.ok(new Date(result.expiresAt).getTime() > Date.now());
  });

  it('respects SESSION_TTL_MS for the created session expiry', async () => {
    process.env.SESSION_TTL_MS = String(60_000);
    const before = Date.now();

    const result = await loginWithGitHub('code-abc', {
      userRepo: { upsertByProviderAccount: async () => fakeUser('user-1') },
      sessionRepo: { create: async () => {}, getValidByIdAndTouch: async () => undefined, deleteById: async () => {} },
      completeGitHubOAuthLogin: async () => ({ id: 1, login: 'octocat', email: null, name: null, avatarUrl: null }),
    });

    const expiresAtMs = new Date(result.expiresAt).getTime();
    assert.ok(expiresAtMs >= before + 59_000 && expiresAtMs <= before + 61_000);
  });

  it('propagates GitHubOAuthError from the OAuth exchange without creating a session', async () => {
    let sessionCreated = false;
    await assert.rejects(
      () => loginWithGitHub('bad-code', {
        userRepo: { upsertByProviderAccount: async () => fakeUser('user-1') },
        sessionRepo: { create: async () => { sessionCreated = true; }, getValidByIdAndTouch: async () => undefined, deleteById: async () => {} },
        completeGitHubOAuthLogin: async () => { throw new GitHubOAuthError('rejected', 'OAUTH_EXCHANGE_FAILED'); },
      }),
      (error: unknown) => error instanceof GitHubOAuthError,
    );
    assert.equal(sessionCreated, false);
  });
});

describe('auth-service — switching GitHub accounts (regression)', () => {
  it('logging in as a second, different GitHub profile id never reuses the first account\'s user row or session — each login resolves strictly from the exchanged OAuth profile, never from prior state', async () => {
    // In-memory fake standing in for the real Postgres unique constraint on
    // (primary_provider, primary_provider_account_id) — see db/user-repository.ts.
    const usersByAccountId = new Map<string, AuthUser>();
    const sessions = new Map<string, string>(); // sessionId -> userId

    const userRepo = {
      upsertByProviderAccount: async (input: { primaryProviderAccountId: string; primaryProviderLogin: string }) => {
        const existing = usersByAccountId.get(input.primaryProviderAccountId);
        if (existing) return existing;
        const created: AuthUser = {
          id: `user-${input.primaryProviderAccountId}`,
          primaryProvider: 'GITHUB',
          primaryProviderLogin: input.primaryProviderLogin,
          email: null,
          displayName: null,
        };
        usersByAccountId.set(input.primaryProviderAccountId, created);
        return created;
      },
    };
    const sessionRepo = {
      create: async (input: { id: string; userId: string }) => { sessions.set(input.id, input.userId); },
      getValidByIdAndTouch: async () => undefined,
      deleteById: async () => {},
    };

    const resultA = await loginWithGitHub('code-account-a', {
      userRepo,
      sessionRepo,
      completeGitHubOAuthLogin: async () => ({ id: 111, login: 'account-a', email: null, name: null, avatarUrl: null }),
    });
    assert.equal(resultA.user.id, 'user-111');
    assert.equal(resultA.user.primaryProviderLogin, 'account-a');

    // Simulate the exact reported scenario: without logging out, a second
    // /auth/github/callback happens (e.g. after a fresh authorize round-trip)
    // and this time the exchanged code resolves to a genuinely different
    // GitHub identity. loginWithGitHub must derive the user solely from this
    // new profile, never from resultA's session/user.
    const resultB = await loginWithGitHub('code-account-b', {
      userRepo,
      sessionRepo,
      completeGitHubOAuthLogin: async () => ({ id: 222, login: 'account-b', email: null, name: null, avatarUrl: null }),
    });
    assert.equal(resultB.user.id, 'user-222');
    assert.equal(resultB.user.primaryProviderLogin, 'account-b');

    // The two accounts must be distinct user rows, with distinct sessions
    // each associated with the correct user — no cross-contamination.
    assert.notEqual(resultA.user.id, resultB.user.id);
    assert.notEqual(resultA.sessionId, resultB.sessionId);
    assert.equal(sessions.get(resultA.sessionId), 'user-111');
    assert.equal(sessions.get(resultB.sessionId), 'user-222');
    assert.equal(usersByAccountId.size, 2);
  });

  it('logging in again as the SAME GitHub profile id reuses that one user row (not a new user) but still issues a fresh session', async () => {
    const usersByAccountId = new Map<string, AuthUser>();
    const sessions = new Map<string, string>();
    const userRepo = {
      upsertByProviderAccount: async (input: { primaryProviderAccountId: string; primaryProviderLogin: string }) => {
        const existing = usersByAccountId.get(input.primaryProviderAccountId);
        if (existing) return existing;
        const created: AuthUser = { id: `user-${input.primaryProviderAccountId}`, primaryProvider: 'GITHUB', primaryProviderLogin: input.primaryProviderLogin, email: null, displayName: null };
        usersByAccountId.set(input.primaryProviderAccountId, created);
        return created;
      },
    };
    const sessionRepo = {
      create: async (input: { id: string; userId: string }) => { sessions.set(input.id, input.userId); },
      getValidByIdAndTouch: async () => undefined,
      deleteById: async () => {},
    };
    const completeGitHubOAuthLogin = async () => ({ id: 111, login: 'account-a', email: null, name: null, avatarUrl: null });

    const first = await loginWithGitHub('code-1', { userRepo, sessionRepo, completeGitHubOAuthLogin });
    const second = await loginWithGitHub('code-2', { userRepo, sessionRepo, completeGitHubOAuthLogin });

    assert.equal(first.user.id, second.user.id);
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(usersByAccountId.size, 1);
  });
});

describe('auth-service — resolveSessionUser / logout', () => {
  it('resolveSessionUser returns undefined when no sessionId is given (never calls the repo)', async () => {
    let called = false;
    const user = await resolveSessionUser(undefined, {
      getValidByIdAndTouch: async () => { called = true; return undefined; },
      create: async () => {},
      deleteById: async () => {},
    });
    assert.equal(user, undefined);
    assert.equal(called, false);
  });

  it('resolveSessionUser returns the session\'s user when the session is valid', async () => {
    const session: SessionWithUser = { sessionId: 's1', expiresAt: new Date().toISOString(), user: fakeUser('user-1') };
    const user = await resolveSessionUser('s1', {
      getValidByIdAndTouch: async (id) => (id === 's1' ? session : undefined),
      create: async () => {},
      deleteById: async () => {},
    });
    assert.equal(user?.id, 'user-1');
  });

  it('logout deletes the session by id and is a no-op for an undefined sessionId', async () => {
    const deleted: string[] = [];
    await logout('s1', { deleteById: async (id) => { deleted.push(id); }, create: async () => {}, getValidByIdAndTouch: async () => undefined });
    await logout(undefined, { deleteById: async (id) => { deleted.push(id); }, create: async () => {}, getValidByIdAndTouch: async () => undefined });
    assert.deepEqual(deleted, ['s1']);
  });
});

describe('AuthError', () => {
  it('carries the given error code', () => {
    const error = new AuthError('nope', 'UNAUTHENTICATED');
    assert.equal(error.code, 'UNAUTHENTICATED');
    assert.equal(error.name, 'AuthError');
  });
});
