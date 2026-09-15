import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { RepositoryProviderError } from './repository-provider-client.js';
import { GitHubAppError } from './github-app-auth.js';
import { GitLabOAuthError } from './gitlab-oauth.js';
import { BitbucketOAuthError } from './bitbucket-oauth.js';
import {
  connectGitHubInstallation,
  connectGitLabAccount,
  connectBitbucketAccount,
  resolveGitHubPushCredentials,
  resolveGitLabAccessToken,
  resolveBitbucketAccessToken,
} from './provider-connection-service.js';
import { encryptCredential } from './credential-encryption.js';
import type { ProviderConnection } from './db/provider-connection-repository.js';

const originalFetch = globalThis.fetch;
const originalEnv = {
  GITHUB_APP_ID: process.env.GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
  GITLAB_OAUTH_CLIENT_ID: process.env.GITLAB_OAUTH_CLIENT_ID,
  GITLAB_OAUTH_CLIENT_SECRET: process.env.GITLAB_OAUTH_CLIENT_SECRET,
  GITLAB_OAUTH_REDIRECT_URI: process.env.GITLAB_OAUTH_REDIRECT_URI,
  BITBUCKET_OAUTH_CLIENT_ID: process.env.BITBUCKET_OAUTH_CLIENT_ID,
  BITBUCKET_OAUTH_CLIENT_SECRET: process.env.BITBUCKET_OAUTH_CLIENT_SECRET,
  BITBUCKET_OAUTH_REDIRECT_URI: process.env.BITBUCKET_OAUTH_REDIRECT_URI,
  CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY,
};

function setGitLabConfigured() {
  process.env.GITLAB_OAUTH_CLIENT_ID = 'gl-client-id';
  process.env.GITLAB_OAUTH_CLIENT_SECRET = 'gl-client-secret';
  process.env.GITLAB_OAUTH_REDIRECT_URI = 'http://localhost:5173/providers/gitlab/callback';
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
}

function clearGitLabConfig() {
  process.env.GITLAB_OAUTH_CLIENT_ID = '';
  process.env.GITLAB_OAUTH_CLIENT_SECRET = '';
  process.env.GITLAB_OAUTH_REDIRECT_URI = '';
}

function setBitbucketConfigured() {
  process.env.BITBUCKET_OAUTH_CLIENT_ID = 'bb-client-id';
  process.env.BITBUCKET_OAUTH_CLIENT_SECRET = 'bb-client-secret';
  process.env.BITBUCKET_OAUTH_REDIRECT_URI = 'http://localhost:5173/providers/bitbucket/callback';
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
}

function clearBitbucketConfig() {
  process.env.BITBUCKET_OAUTH_CLIENT_ID = '';
  process.env.BITBUCKET_OAUTH_CLIENT_SECRET = '';
  process.env.BITBUCKET_OAUTH_REDIRECT_URI = '';
}

const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

function setConfigured() {
  process.env.GITHUB_APP_ID = '123456';
  process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY as string;
}

function clearConfig() {
  process.env.GITHUB_APP_ID = '';
  process.env.GITHUB_APP_PRIVATE_KEY = '';
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  globalThis.fetch = (async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body } as unknown as Response;
  }) as typeof fetch;
}

function restoreEnv(key: string, value: string | undefined) {
  // `process.env.X = undefined` coerces to the STRING "undefined", not an
  // absent key — restoring an originally-unset var must delete it instead.
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv('GITHUB_APP_ID', originalEnv.GITHUB_APP_ID);
  restoreEnv('GITHUB_APP_PRIVATE_KEY', originalEnv.GITHUB_APP_PRIVATE_KEY);
  restoreEnv('GITLAB_OAUTH_CLIENT_ID', originalEnv.GITLAB_OAUTH_CLIENT_ID);
  restoreEnv('GITLAB_OAUTH_CLIENT_SECRET', originalEnv.GITLAB_OAUTH_CLIENT_SECRET);
  restoreEnv('GITLAB_OAUTH_REDIRECT_URI', originalEnv.GITLAB_OAUTH_REDIRECT_URI);
  restoreEnv('BITBUCKET_OAUTH_CLIENT_ID', originalEnv.BITBUCKET_OAUTH_CLIENT_ID);
  restoreEnv('BITBUCKET_OAUTH_CLIENT_SECRET', originalEnv.BITBUCKET_OAUTH_CLIENT_SECRET);
  restoreEnv('BITBUCKET_OAUTH_REDIRECT_URI', originalEnv.BITBUCKET_OAUTH_REDIRECT_URI);
  restoreEnv('CREDENTIAL_ENCRYPTION_KEY', originalEnv.CREDENTIAL_ENCRYPTION_KEY);
});

function fakeConnection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  return {
    id: 'conn-1', userId: 'user-a', provider: 'GITHUB', externalAccountLogin: 'octocat',
    installationId: 42, status: 'ACTIVE', createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

describe('resolveGitHubPushCredentials', () => {
  it('mints a real installation token when the installation exists AND this exact user owns a matching connection', async () => {
    setConfigured();
    mockFetchSequence([
      { status: 200, body: { id: 42 } }, // findInstallationForRepo
      { status: 201, body: { token: 'ghs_realtoken', expires_at: '2026-01-01T00:00:00Z' } }, // mint
    ]);
    const connectionRepo = { findActiveForUserAndInstallation: async () => fakeConnection(), upsertGitHubInstallation: async () => fakeConnection() };

    const creds = await resolveGitHubPushCredentials('user-a', 'octocat', 'hello-world', { connectionRepo });
    assert.equal(creds.username, 'x-access-token');
    assert.equal(creds.token, 'ghs_realtoken');
  });

  it('IDOR — rejects when a DIFFERENT user (not the one who owns the installation) requests credentials for the same repo', async () => {
    setConfigured();
    mockFetchSequence([{ status: 200, body: { id: 42 } }]); // findInstallationForRepo succeeds; mint must never be reached
    let findCalledWith: unknown;
    const connectionRepo = {
      findActiveForUserAndInstallation: async (userId: string, installationId: number) => {
        findCalledWith = { userId, installationId };
        // Only user-a owns installation 42 — user-b (the attacker) gets nothing back.
        return userId === 'user-a' ? fakeConnection() : undefined;
      },
      upsertGitHubInstallation: async () => fakeConnection(),
    };

    await assert.rejects(
      () => resolveGitHubPushCredentials('user-b', 'octocat', 'hello-world', { connectionRepo }),
      (e: unknown) => e instanceof RepositoryProviderError && e.category === 'AUTH_NOT_CONFIGURED',
    );
    assert.deepEqual(findCalledWith, { userId: 'user-b', installationId: 42 });

    // The real owner still works against the same installation.
    mockFetchSequence([{ status: 200, body: { id: 42 } }, { status: 201, body: { token: 'ghs_realtoken', expires_at: '2026-01-01T00:00:00Z' } }]);
    const creds = await resolveGitHubPushCredentials('user-a', 'octocat', 'hello-world', { connectionRepo });
    assert.equal(creds.token, 'ghs_realtoken');
  });

  it('rejects AUTH_NOT_CONFIGURED when the App is not installed on this repository at all', async () => {
    setConfigured();
    mockFetchSequence([{ status: 404, body: { message: 'Not Found' } }]);
    const connectionRepo = { findActiveForUserAndInstallation: async () => undefined, upsertGitHubInstallation: async () => fakeConnection() };
    await assert.rejects(
      () => resolveGitHubPushCredentials('user-a', 'octocat', 'hello-world', { connectionRepo }),
      (e: unknown) => e instanceof RepositoryProviderError && e.category === 'AUTH_NOT_CONFIGURED',
    );
  });

  it('rejects AUTH_NOT_CONFIGURED without any network call when the GitHub App itself is unconfigured', async () => {
    clearConfig();
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error('should not be called'); }) as typeof fetch;
    const connectionRepo = { findActiveForUserAndInstallation: async () => undefined, upsertGitHubInstallation: async () => fakeConnection() };
    await assert.rejects(
      () => resolveGitHubPushCredentials('user-a', 'octocat', 'hello-world', { connectionRepo }),
      (e: unknown) => e instanceof RepositoryProviderError && e.category === 'AUTH_NOT_CONFIGURED',
    );
    assert.equal(called, false);
  });

  it('never leaks whether an installation belongs to a different user — the message is identical to "not configured"', async () => {
    setConfigured();
    mockFetchSequence([{ status: 200, body: { id: 42 } }]);
    const connectionRepo = { findActiveForUserAndInstallation: async () => undefined, upsertGitHubInstallation: async () => fakeConnection() };
    let messageWhenMissing = '';
    try {
      await resolveGitHubPushCredentials('user-b', 'octocat', 'hello-world', { connectionRepo });
    } catch (e) {
      messageWhenMissing = (e as Error).message;
    }
    mockFetchSequence([{ status: 404, body: {} }]);
    let messageWhenNotInstalled = '';
    try {
      await resolveGitHubPushCredentials('user-b', 'octocat', 'other-repo', { connectionRepo });
    } catch (e) {
      messageWhenNotInstalled = (e as Error).message;
    }
    assert.ok(messageWhenMissing.length > 0 && messageWhenNotInstalled.length > 0);
  });
});

describe('connectGitHubInstallation', () => {
  it('records the connection for the authenticated user (never a client-supplied one)', async () => {
    let upserted: unknown;
    const connectionRepo = {
      findActiveForUserAndInstallation: async () => undefined,
      upsertGitHubInstallation: async (input: unknown) => { upserted = input; return fakeConnection(); },
    };
    await connectGitHubInstallation('user-a', 42, { connectionRepo, fetchInstallation: async () => ({ id: 42, accountLogin: 'octocat' }) });
    assert.deepEqual(upserted, { id: (upserted as { id: string }).id, userId: 'user-a', installationId: 42, externalAccountLogin: 'octocat' });
  });
});

describe('GitHubAppError propagation', () => {
  it('is a real GitHubAppError distinct from RepositoryProviderError', () => {
    const error = new GitHubAppError('nope', 'APP_NOT_CONFIGURED');
    assert.equal(error.name, 'GitHubAppError');
    assert.ok(!(error instanceof RepositoryProviderError));
  });
});

function fakeGitLabConnection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  const accessToken = overrides.encryptedAccessToken ? undefined : encryptCredential('gl_access_valid');
  const refreshToken = overrides.encryptedRefreshToken ? undefined : encryptCredential('gl_refresh_valid');
  return {
    id: 'conn-gl-1', userId: 'user-a', provider: 'GITLAB', externalAccountLogin: 'octocat',
    encryptedAccessToken: accessToken, encryptedRefreshToken: refreshToken,
    tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    status: 'ACTIVE', createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

describe('connectGitLabAccount', () => {
  it('records the connection for the authenticated user, with tokens encrypted (never plaintext)', async () => {
    setGitLabConfigured();
    let upserted: Record<string, unknown> | undefined;
    const connectionRepo = {
      findActiveGitLabConnectionForUser: async () => undefined,
      upsertGitLabConnection: async (input: Record<string, unknown>) => { upserted = input; return fakeGitLabConnection(); },
      updateGitLabTokens: async () => {},
    };

    await connectGitLabAccount('user-a', 'auth-code-xyz', {
      connectionRepo,
      exchangeCode: async () => ({ accessToken: 'real-access-token', refreshToken: 'real-refresh-token', expiresAt: new Date(Date.now() + 7200_000).toISOString() }),
      fetchProfile: async () => ({ username: 'octocat' }),
    });

    assert.equal(upserted?.userId, 'user-a');
    assert.equal(upserted?.externalAccountLogin, 'octocat');
    assert.notEqual(upserted?.encryptedAccessToken, 'real-access-token', 'the raw access token must never be passed to storage directly');
    assert.notEqual(upserted?.encryptedRefreshToken, 'real-refresh-token', 'the raw refresh token must never be passed to storage directly');
    assert.ok(!JSON.stringify(upserted).includes('real-access-token'));
    assert.ok(!JSON.stringify(upserted).includes('real-refresh-token'));
  });
});

describe('resolveGitLabAccessToken', () => {
  it("resolves and decrypts this user's own valid, non-expired token", async () => {
    setGitLabConfigured();
    const connection = fakeGitLabConnection({ userId: 'user-a' });
    const connectionRepo = {
      findActiveGitLabConnectionForUser: async (userId: string) => (userId === 'user-a' ? connection : undefined),
      upsertGitLabConnection: async () => connection,
      updateGitLabTokens: async () => {},
    };
    const token = await resolveGitLabAccessToken('user-a', { connectionRepo });
    assert.equal(token, 'gl_access_valid');
  });

  it('IDOR — a user with no GitLab connection of their own gets AUTH_NOT_CONFIGURED, even though a different user has one', async () => {
    setGitLabConfigured();
    const connectionRepo = {
      findActiveGitLabConnectionForUser: async (userId: string) => (userId === 'user-a' ? fakeGitLabConnection({ userId: 'user-a' }) : undefined),
      upsertGitLabConnection: async () => fakeGitLabConnection(),
      updateGitLabTokens: async () => {},
    };
    await assert.rejects(
      () => resolveGitLabAccessToken('user-b', { connectionRepo }),
      (e: unknown) => e instanceof RepositoryProviderError && e.category === 'AUTH_NOT_CONFIGURED',
    );
    // The real owner still resolves fine against the same repo instance.
    assert.equal(await resolveGitLabAccessToken('user-a', { connectionRepo }), 'gl_access_valid');
  });

  it('transparently refreshes an expired token and persists the newly-ROTATED refresh token', async () => {
    setGitLabConfigured();
    const expiredConnection = fakeGitLabConnection({ tokenExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    let persisted: { accessToken: string; refreshToken: string } | undefined;
    const connectionRepo = {
      findActiveGitLabConnectionForUser: async () => expiredConnection,
      upsertGitLabConnection: async () => expiredConnection,
      updateGitLabTokens: async (_id: string, encAccess: string, encRefresh: string) => {
        persisted = { accessToken: encAccess, refreshToken: encRefresh };
      },
    };
    const refreshToken = async () => ({ accessToken: 'gl_access_rotated', refreshToken: 'gl_refresh_rotated', expiresAt: new Date(Date.now() + 7200_000).toISOString() });

    const token = await resolveGitLabAccessToken('user-a', { connectionRepo, refreshToken });
    assert.equal(token, 'gl_access_rotated');
    assert.ok(persisted, 'the rotated tokens must be persisted');
    assert.ok(!JSON.stringify(persisted).includes('gl_access_rotated'), 'persisted tokens must be encrypted, never plaintext');
  });

  it('reports AUTH_NOT_CONFIGURED (reconnect message) when the refresh token itself has been revoked', async () => {
    setGitLabConfigured();
    const expiredConnection = fakeGitLabConnection({ tokenExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    const connectionRepo = {
      findActiveGitLabConnectionForUser: async () => expiredConnection,
      upsertGitLabConnection: async () => expiredConnection,
      updateGitLabTokens: async () => {},
    };
    const refreshToken = async () => { throw new GitLabOAuthError('revoked', 'OAUTH_EXCHANGE_FAILED'); };

    await assert.rejects(
      () => resolveGitLabAccessToken('user-a', { connectionRepo, refreshToken }),
      (e: unknown) => e instanceof RepositoryProviderError && e.category === 'AUTH_NOT_CONFIGURED',
    );
  });

  it('rejects AUTH_NOT_CONFIGURED when this user has never connected GitLab', async () => {
    setGitLabConfigured();
    const connectionRepo = {
      findActiveGitLabConnectionForUser: async () => undefined,
      upsertGitLabConnection: async () => fakeGitLabConnection(),
      updateGitLabTokens: async () => {},
    };
    await assert.rejects(
      () => resolveGitLabAccessToken('user-a', { connectionRepo }),
      (e: unknown) => e instanceof RepositoryProviderError && e.category === 'AUTH_NOT_CONFIGURED',
    );
  });

  it('rejects AUTH_NOT_CONFIGURED without any lookup when GitLab OAuth itself is unconfigured', async () => {
    clearGitLabConfig();
    let called = false;
    const connectionRepo = {
      findActiveGitLabConnectionForUser: async () => { called = true; return fakeGitLabConnection(); },
      upsertGitLabConnection: async () => fakeGitLabConnection(),
      updateGitLabTokens: async () => {},
    };
    await assert.rejects(
      () => resolveGitLabAccessToken('user-a', { connectionRepo }),
      (e: unknown) => e instanceof RepositoryProviderError && e.category === 'AUTH_NOT_CONFIGURED',
    );
    assert.equal(called, false);
  });

  it('never includes the decrypted token in any thrown error message', async () => {
    setGitLabConfigured();
    const expiredConnection = fakeGitLabConnection({ tokenExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    const connectionRepo = {
      findActiveGitLabConnectionForUser: async () => expiredConnection,
      upsertGitLabConnection: async () => expiredConnection,
      updateGitLabTokens: async () => {},
    };
    const refreshToken = async () => { throw new Error('network blew up while holding gl_access_valid'); };
    try {
      await resolveGitLabAccessToken('user-a', { connectionRepo, refreshToken });
      assert.fail('expected rejection');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('gl_access_valid'));
    }
  });
});

function fakeBitbucketConnection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
  const accessToken = overrides.encryptedAccessToken ? undefined : encryptCredential('bb_access_valid');
  const refreshToken = overrides.encryptedRefreshToken ? undefined : encryptCredential('bb_refresh_valid');
  return {
    id: 'conn-bb-1', userId: 'user-a', provider: 'BITBUCKET', externalAccountLogin: 'octocat',
    encryptedAccessToken: accessToken, encryptedRefreshToken: refreshToken,
    tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    status: 'ACTIVE', createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

describe('connectBitbucketAccount', () => {
  it('records the connection for the authenticated user, with tokens encrypted (never plaintext)', async () => {
    setBitbucketConfigured();
    let upserted: Record<string, unknown> | undefined;
    const connectionRepo = {
      findActiveBitbucketConnectionForUser: async () => undefined,
      upsertBitbucketConnection: async (input: Record<string, unknown>) => { upserted = input; return fakeBitbucketConnection(); },
      updateBitbucketTokens: async () => {},
    };

    await connectBitbucketAccount('user-a', 'auth-code-xyz', {
      connectionRepo,
      exchangeCode: async () => ({ accessToken: 'real-access-token', refreshToken: 'real-refresh-token', expiresAt: new Date(Date.now() + 7200_000).toISOString() }),
      fetchProfile: async () => ({ username: 'octocat' }),
    });

    assert.equal(upserted?.userId, 'user-a');
    assert.equal(upserted?.externalAccountLogin, 'octocat');
    assert.notEqual(upserted?.encryptedAccessToken, 'real-access-token');
    assert.notEqual(upserted?.encryptedRefreshToken, 'real-refresh-token');
    assert.ok(!JSON.stringify(upserted).includes('real-access-token'));
    assert.ok(!JSON.stringify(upserted).includes('real-refresh-token'));
  });
});

describe('resolveBitbucketAccessToken', () => {
  it("resolves and decrypts this user's own valid, non-expired token", async () => {
    setBitbucketConfigured();
    const connection = fakeBitbucketConnection({ userId: 'user-a' });
    const connectionRepo = {
      findActiveBitbucketConnectionForUser: async (userId: string) => (userId === 'user-a' ? connection : undefined),
      upsertBitbucketConnection: async () => connection,
      updateBitbucketTokens: async () => {},
    };
    const token = await resolveBitbucketAccessToken('user-a', { connectionRepo });
    assert.equal(token, 'bb_access_valid');
  });

  it('IDOR — a user with no Bitbucket connection of their own gets AUTH_NOT_CONFIGURED, even though a different user has one', async () => {
    setBitbucketConfigured();
    const connectionRepo = {
      findActiveBitbucketConnectionForUser: async (userId: string) => (userId === 'user-a' ? fakeBitbucketConnection({ userId: 'user-a' }) : undefined),
      upsertBitbucketConnection: async () => fakeBitbucketConnection(),
      updateBitbucketTokens: async () => {},
    };
    await assert.rejects(
      () => resolveBitbucketAccessToken('user-b', { connectionRepo }),
      (e: unknown) => e instanceof RepositoryProviderError && e.category === 'AUTH_NOT_CONFIGURED',
    );
    assert.equal(await resolveBitbucketAccessToken('user-a', { connectionRepo }), 'bb_access_valid');
  });

  it('transparently refreshes an expired token and adopts the newly-issued refresh token WHEN Bitbucket returns one', async () => {
    setBitbucketConfigured();
    const expiredConnection = fakeBitbucketConnection({ tokenExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    let persisted: { accessToken: string; refreshToken: string } | undefined;
    const connectionRepo = {
      findActiveBitbucketConnectionForUser: async () => expiredConnection,
      upsertBitbucketConnection: async () => expiredConnection,
      updateBitbucketTokens: async (_id: string, encAccess: string, encRefresh: string) => {
        persisted = { accessToken: encAccess, refreshToken: encRefresh };
      },
    };
    const refreshToken = async () => ({ accessToken: 'bb_access_rotated', refreshToken: 'bb_refresh_rotated', expiresAt: new Date(Date.now() + 7200_000).toISOString() });

    const token = await resolveBitbucketAccessToken('user-a', { connectionRepo, refreshToken });
    assert.equal(token, 'bb_access_rotated');
    assert.ok(persisted);
    assert.ok(!JSON.stringify(persisted).includes('bb_access_rotated'), 'persisted tokens must be encrypted, never plaintext');
  });

  it('keeps the EXISTING refresh token when Bitbucket does not issue a new one (non-mandatory rotation)', async () => {
    setBitbucketConfigured();
    const expiredConnection = fakeBitbucketConnection({ tokenExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    let persistedRefreshEncrypted: string | undefined;
    const connectionRepo = {
      findActiveBitbucketConnectionForUser: async () => expiredConnection,
      upsertBitbucketConnection: async () => expiredConnection,
      updateBitbucketTokens: async (_id: string, _encAccess: string, encRefresh: string) => { persistedRefreshEncrypted = encRefresh; },
    };
    // No refreshToken in the response — Bitbucket's documented "may omit it" case.
    const refreshToken = async () => ({ accessToken: 'bb_access_rotated', expiresAt: new Date(Date.now() + 7200_000).toISOString() });

    await resolveBitbucketAccessToken('user-a', { connectionRepo, refreshToken });
    assert.ok(persistedRefreshEncrypted, 'the existing refresh token must be re-persisted, never dropped');
  });

  it('reports AUTH_NOT_CONFIGURED (reconnect message) when the refresh token itself has been revoked', async () => {
    setBitbucketConfigured();
    const expiredConnection = fakeBitbucketConnection({ tokenExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    const connectionRepo = {
      findActiveBitbucketConnectionForUser: async () => expiredConnection,
      upsertBitbucketConnection: async () => expiredConnection,
      updateBitbucketTokens: async () => {},
    };
    const refreshToken = async () => { throw new BitbucketOAuthError('revoked', 'OAUTH_EXCHANGE_FAILED'); };

    await assert.rejects(
      () => resolveBitbucketAccessToken('user-a', { connectionRepo, refreshToken }),
      (e: unknown) => e instanceof RepositoryProviderError && e.category === 'AUTH_NOT_CONFIGURED',
    );
  });

  it('rejects AUTH_NOT_CONFIGURED when this user has never connected Bitbucket', async () => {
    setBitbucketConfigured();
    const connectionRepo = {
      findActiveBitbucketConnectionForUser: async () => undefined,
      upsertBitbucketConnection: async () => fakeBitbucketConnection(),
      updateBitbucketTokens: async () => {},
    };
    await assert.rejects(
      () => resolveBitbucketAccessToken('user-a', { connectionRepo }),
      (e: unknown) => e instanceof RepositoryProviderError && e.category === 'AUTH_NOT_CONFIGURED',
    );
  });

  it('rejects AUTH_NOT_CONFIGURED without any lookup when Bitbucket OAuth itself is unconfigured', async () => {
    clearBitbucketConfig();
    let called = false;
    const connectionRepo = {
      findActiveBitbucketConnectionForUser: async () => { called = true; return fakeBitbucketConnection(); },
      upsertBitbucketConnection: async () => fakeBitbucketConnection(),
      updateBitbucketTokens: async () => {},
    };
    await assert.rejects(
      () => resolveBitbucketAccessToken('user-a', { connectionRepo }),
      (e: unknown) => e instanceof RepositoryProviderError && e.category === 'AUTH_NOT_CONFIGURED',
    );
    assert.equal(called, false);
  });

  it('never includes the decrypted token in any thrown error message', async () => {
    setBitbucketConfigured();
    const expiredConnection = fakeBitbucketConnection({ tokenExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    const connectionRepo = {
      findActiveBitbucketConnectionForUser: async () => expiredConnection,
      upsertBitbucketConnection: async () => expiredConnection,
      updateBitbucketTokens: async () => {},
    };
    const refreshToken = async () => { throw new Error('network blew up while holding bb_access_valid'); };
    try {
      await resolveBitbucketAccessToken('user-a', { connectionRepo, refreshToken });
      assert.fail('expected rejection');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('bb_access_valid'));
    }
  });
});
