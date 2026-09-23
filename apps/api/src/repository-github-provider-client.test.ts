import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubProviderClient } from './repository-github-provider-client.js';
import { RepositoryProviderError } from './repository-provider-client.js';

const originalFetch = globalThis.fetch;
const originalToken = process.env.GITHUB_TOKEN;

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const { status, body } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status-${status}`,
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.GITHUB_TOKEN = originalToken;
});

describe('GitHubProviderClient — getPushCredentials (Phase 13/16C — GITHUB_TOKEN fallback when no GitHub App is configured)', () => {
  const originalAppId = process.env.GITHUB_APP_ID;
  const originalAppKey = process.env.GITHUB_APP_PRIVATE_KEY;

  beforeEach(() => {
    // Phase 16/C: the GITHUB_TOKEN fallback only applies when a GitHub App
    // is NOT configured — clear both explicitly so these tests exercise
    // exactly that fallback path, regardless of what's in the real .env.
    process.env.GITHUB_APP_ID = '';
    process.env.GITHUB_APP_PRIVATE_KEY = '';
  });

  afterEach(() => {
    // `process.env.X = undefined` coerces to the STRING "undefined", not an
    // absent key — restoring an originally-unset var must delete it instead.
    if (originalAppId === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = originalAppId;
    if (originalAppKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = originalAppKey;
  });

  it('returns the x-access-token/token pair when GITHUB_TOKEN is configured', async () => {
    process.env.GITHUB_TOKEN = 'ghp_realtoken';
    const client = new GitHubProviderClient();
    const creds = await client.getPushCredentials('user-1', 'octocat', 'Hello-World');
    assert.equal(creds.username, 'x-access-token');
    assert.equal(creds.token, 'ghp_realtoken');
  });

  it('rejects with AUTH_NOT_CONFIGURED (no network) when neither a GitHub App nor GITHUB_TOKEN is configured', async () => {
    process.env.GITHUB_TOKEN = '';
    const client = new GitHubProviderClient();
    await assert.rejects(
      () => client.getPushCredentials('user-1', 'octocat', 'Hello-World'),
      (error: unknown) => error instanceof RepositoryProviderError && error.category === 'AUTH_NOT_CONFIGURED',
    );
  });
});

describe('GitHubProviderClient — no credential leakage / configuration', () => {
  it('TEST 21/24 — throws AUTH_NOT_CONFIGURED without ever calling fetch when GITHUB_TOKEN is missing', async () => {
    process.env.GITHUB_TOKEN = '';
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error('should not be called'); }) as typeof fetch;

    const client = new GitHubProviderClient();
    await assert.rejects(
      () => client.getRepositoryInfo('user-1', 'octocat', 'Hello-World'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'AUTH_NOT_CONFIGURED'); return true; },
    );
    assert.equal(fetchCalled, false);
  });

  it('never sends the token anywhere but the Authorization header, and no error message contains it', async () => {
    process.env.GITHUB_TOKEN = 'ghp_supersecrettoken12345';
    let capturedHeaders: Record<string, string> = {};
    mockFetch((url, init) => {
      capturedHeaders = (init.headers ?? {}) as Record<string, string>;
      return { status: 200, body: { default_branch: 'main' } };
    });

    const client = new GitHubProviderClient();
    const info = await client.getRepositoryInfo('user-1', 'octocat', 'Hello-World');
    assert.equal(info.defaultBranch, 'main');
    assert.equal(capturedHeaders.Authorization, 'Bearer ghp_supersecrettoken12345');
  });
});

describe('GitHubProviderClient — repository info / access', () => {
  beforeEach(() => { process.env.GITHUB_TOKEN = 'test-token'; });

  it('TEST 20 — parses a real-shaped GitHub repo response into RepositoryInfo', async () => {
    mockFetch(() => ({ status: 200, body: { default_branch: 'develop', full_name: 'octocat/Hello-World' } }));
    const client = new GitHubProviderClient();
    const info = await client.getRepositoryInfo('user-1', 'octocat', 'Hello-World');
    assert.equal(info.defaultBranch, 'develop');
  });

  it('TEST 21 — classifies a 401 as AUTH_FAILED', async () => {
    mockFetch(() => ({ status: 401, body: { message: 'Bad credentials' } }));
    const client = new GitHubProviderClient();
    await assert.rejects(
      () => client.validateRemoteAccess('user-1', 'octocat', 'Hello-World'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'AUTH_FAILED'); return true; },
    );
  });

  it('classifies a 404 as NOT_FOUND', async () => {
    mockFetch(() => ({ status: 404, body: { message: 'Not Found' } }));
    const client = new GitHubProviderClient();
    await assert.rejects(
      () => client.validateRemoteAccess('user-1', 'octocat', 'does-not-exist'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'NOT_FOUND'); return true; },
    );
  });

  it('classifies a 403 as RATE_LIMITED', async () => {
    mockFetch(() => ({ status: 403, body: { message: 'API rate limit exceeded' } }));
    const client = new GitHubProviderClient();
    await assert.rejects(
      () => client.validateRemoteAccess('user-1', 'octocat', 'Hello-World'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'RATE_LIMITED'); return true; },
    );
  });

  it('a GitHub error message never leaks the raw response body/token into the thrown error', async () => {
    process.env.GITHUB_TOKEN = 'ghp_shouldneverleak';
    mockFetch(() => ({ status: 401, body: { message: 'Bad credentials for ghp_shouldneverleak' } }));
    const client = new GitHubProviderClient();
    try {
      await client.validateRemoteAccess('user-1', 'octocat', 'Hello-World');
      assert.fail('expected rejection');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('ghp_shouldneverleak'));
    }
  });
});

describe('GitHubProviderClient — createPullRequest', () => {
  beforeEach(() => { process.env.GITHUB_TOKEN = 'test-token'; });

  it('TEST 17 — creates a PR and returns its number/url', async () => {
    mockFetch((url, init) => {
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body as string);
      assert.equal(body.head, 'ai-fix/test');
      assert.equal(body.base, 'main');
      return { status: 201, body: { number: 42, html_url: 'https://github.com/octocat/Hello-World/pull/42' } };
    });
    const client = new GitHubProviderClient();
    const pr = await client.createPullRequest('user-1', { owner: 'octocat', repo: 'Hello-World', title: 'Fix', body: 'body', head: 'ai-fix/test', base: 'main' });
    assert.equal(pr.number, 42);
    assert.equal(pr.url, 'https://github.com/octocat/Hello-World/pull/42');
    assert.equal(pr.alreadyExisted, false);
  });

  it('TEST 18 — a request failure is surfaced as a RepositoryProviderError, never thrown raw', async () => {
    mockFetch(() => ({ status: 500, body: { message: 'Internal Server Error' } }));
    const client = new GitHubProviderClient();
    await assert.rejects(
      () => client.createPullRequest('user-1', { owner: 'octocat', repo: 'Hello-World', title: 'Fix', body: 'body', head: 'ai-fix/test', base: 'main' }),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); return true; },
    );
  });

  it('TEST 25 — a 422 "already exists" response is resolved by looking up and returning the existing PR (idempotency)', async () => {
    let call = 0;
    mockFetch((url, init) => {
      call += 1;
      if (init.method === 'POST') return { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for octocat:ai-fix/test.' }] } };
      return { status: 200, body: [{ number: 7, html_url: 'https://github.com/octocat/Hello-World/pull/7' }] };
    });
    const client = new GitHubProviderClient();
    const pr = await client.createPullRequest('user-1', { owner: 'octocat', repo: 'Hello-World', title: 'Fix', body: 'body', head: 'ai-fix/test', base: 'main' });
    assert.equal(pr.number, 7);
    assert.equal(pr.alreadyExisted, true);
    assert.equal(call, 2);
  });
});
