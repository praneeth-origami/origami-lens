import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  GitHubAppError,
  buildGitHubAppInstallUrl,
  findInstallationForRepo,
  getInstallation,
  isGitHubAppConfigured,
  mintInstallationAccessToken,
} from './github-app-auth.js';

const originalFetch = globalThis.fetch;
const originalEnv = {
  GITHUB_APP_ID: process.env.GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
  GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG,
};

let testPrivateKeyPem: string;

before(() => {
  // A throwaway, test-only RSA keypair generated fresh for this test run —
  // never a real GitHub App key, never written to disk or the repo.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  testPrivateKeyPem = privateKey as string;
});

function setConfigured() {
  process.env.GITHUB_APP_ID = '123456';
  process.env.GITHUB_APP_PRIVATE_KEY = testPrivateKeyPem;
  process.env.GITHUB_APP_SLUG = 'origami-lens-test-app';
}

function clearConfig() {
  process.env.GITHUB_APP_ID = '';
  process.env.GITHUB_APP_PRIVATE_KEY = '';
  process.env.GITHUB_APP_SLUG = '';
}

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const { status, body } = handler(url, init);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
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
  restoreEnv('GITHUB_APP_SLUG', originalEnv.GITHUB_APP_SLUG);
});

describe('github-app-auth — configuration', () => {
  it('isGitHubAppConfigured is false when either env var is missing', () => {
    clearConfig();
    assert.equal(isGitHubAppConfigured(), false);
    process.env.GITHUB_APP_ID = '123456';
    assert.equal(isGitHubAppConfigured(), false);
  });

  it('isGitHubAppConfigured is true once both are set', () => {
    setConfigured();
    assert.equal(isGitHubAppConfigured(), true);
  });

  it('buildGitHubAppInstallUrl throws APP_NOT_CONFIGURED when GITHUB_APP_SLUG is missing', () => {
    clearConfig();
    assert.throws(() => buildGitHubAppInstallUrl('state-abc'), (e: unknown) => e instanceof GitHubAppError && e.code === 'APP_NOT_CONFIGURED');
  });

  it('buildGitHubAppInstallUrl embeds the app slug and the given state', () => {
    setConfigured();
    const url = new URL(buildGitHubAppInstallUrl('state-abc'));
    assert.equal(url.pathname, '/apps/origami-lens-test-app/installations/new');
    assert.equal(url.searchParams.get('state'), 'state-abc');
  });
});

describe('github-app-auth — findInstallationForRepo', () => {
  it('sends a real RS256 App JWT (never the private key itself) and returns the installation id', async () => {
    setConfigured();
    let capturedAuth = '';
    mockFetch((url, init) => {
      capturedAuth = ((init.headers ?? {}) as Record<string, string>).Authorization ?? '';
      assert.ok(url.endsWith('/repos/octocat/hello-world/installation'));
      return { status: 200, body: { id: 42 } };
    });

    const installationId = await findInstallationForRepo('octocat', 'hello-world');
    assert.equal(installationId, 42);

    assert.match(capturedAuth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, 'must be a well-formed JWT, not the raw private key');
    assert.ok(!capturedAuth.includes('BEGIN RSA PRIVATE KEY'), 'must never send the private key itself');
  });

  it('throws INSTALLATION_NOT_FOUND on a 404 (the App is not installed on this repo)', async () => {
    setConfigured();
    mockFetch(() => ({ status: 404, body: { message: 'Not Found' } }));
    await assert.rejects(
      () => findInstallationForRepo('octocat', 'hello-world'),
      (e: unknown) => e instanceof GitHubAppError && e.code === 'INSTALLATION_NOT_FOUND',
    );
  });

  it('throws APP_NOT_CONFIGURED without ever calling fetch when unconfigured', async () => {
    clearConfig();
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error('should not be called'); }) as typeof fetch;
    await assert.rejects(() => findInstallationForRepo('octocat', 'hello-world'), (e: unknown) => e instanceof GitHubAppError && e.code === 'APP_NOT_CONFIGURED');
    assert.equal(called, false);
  });
});

describe('github-app-auth — mintInstallationAccessToken', () => {
  it('returns the real token/expiry from GitHub, never logging or transforming it', async () => {
    setConfigured();
    mockFetch((url) => {
      assert.ok(url.endsWith('/app/installations/42/access_tokens'));
      return { status: 201, body: { token: 'ghs_realtoken', expires_at: '2026-01-01T00:00:00Z' } };
    });
    const result = await mintInstallationAccessToken(42);
    assert.equal(result.token, 'ghs_realtoken');
    assert.equal(result.expiresAt, '2026-01-01T00:00:00Z');
  });

  it('throws REQUEST_FAILED when GitHub rejects the request', async () => {
    setConfigured();
    mockFetch(() => ({ status: 401, body: { message: 'Bad credentials' } }));
    await assert.rejects(() => mintInstallationAccessToken(42), (e: unknown) => e instanceof GitHubAppError && e.code === 'REQUEST_FAILED');
  });
});

describe('github-app-auth — getInstallation', () => {
  it('returns the installation id and account login', async () => {
    setConfigured();
    mockFetch(() => ({ status: 200, body: { id: 42, account: { login: 'octocat' } } }));
    const info = await getInstallation(42);
    assert.equal(info.id, 42);
    assert.equal(info.accountLogin, 'octocat');
  });
});
