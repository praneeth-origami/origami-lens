import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BitbucketProviderClient } from './repository-bitbucket-provider-client.js';
import { RepositoryProviderError } from './repository-provider-client.js';

const originalFetch = globalThis.fetch;
const originalUsername = process.env.BITBUCKET_USERNAME;
const originalToken = process.env.BITBUCKET_TOKEN;

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
  process.env.BITBUCKET_USERNAME = originalUsername;
  process.env.BITBUCKET_TOKEN = originalToken;
});

describe('BitbucketProviderClient — configuration / no credential leakage', () => {
  it('TEST 5 — throws AUTH_NOT_CONFIGURED without ever calling fetch when credentials are missing entirely', async () => {
    process.env.BITBUCKET_USERNAME = '';
    process.env.BITBUCKET_TOKEN = '';
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error('should not be called'); }) as typeof fetch;

    const client = new BitbucketProviderClient();
    await assert.rejects(
      () => client.getRepositoryInfo('user-1', 'myworkspace', 'myrepo'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'AUTH_NOT_CONFIGURED'); return true; },
    );
    assert.equal(fetchCalled, false);
  });

  it('throws AUTH_NOT_CONFIGURED when only the username is set (token/app-password missing)', async () => {
    process.env.BITBUCKET_USERNAME = 'someuser';
    process.env.BITBUCKET_TOKEN = '';
    const client = new BitbucketProviderClient();
    await assert.rejects(
      () => client.validateRemoteAccess('user-1', 'myworkspace', 'myrepo'),
      (error: unknown) => error instanceof RepositoryProviderError && error.category === 'AUTH_NOT_CONFIGURED',
    );
  });

  it('getPushCredentials returns the real configured username/app-password pair — Bitbucket has no "any username" convention', async () => {
    process.env.BITBUCKET_USERNAME = 'origami-bot';
    process.env.BITBUCKET_TOKEN = 'app-password-secret';
    const client = new BitbucketProviderClient();
    const creds = await client.getPushCredentials('user-1', 'myworkspace', 'myrepo');
    assert.equal(creds.username, 'origami-bot');
    assert.equal(creds.token, 'app-password-secret');
  });

  it('TEST 10 — credentials are sent only as a Basic auth header, and no error message contains them', async () => {
    process.env.BITBUCKET_USERNAME = 'origami-bot';
    process.env.BITBUCKET_TOKEN = 'supersecretapppassword';
    let capturedAuth = '';
    mockFetch((url, init) => {
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return { status: 200, body: { mainbranch: { name: 'main' } } };
    });

    const client = new BitbucketProviderClient();
    const info = await client.getRepositoryInfo('user-1', 'myworkspace', 'myrepo');
    assert.equal(info.defaultBranch, 'main');
    const expected = `Basic ${Buffer.from('origami-bot:supersecretapppassword').toString('base64')}`;
    assert.equal(capturedAuth, expected);
  });
});

describe('BitbucketProviderClient — repository access / metadata', () => {
  beforeEach(() => {
    process.env.BITBUCKET_USERNAME = 'origami-bot';
    process.env.BITBUCKET_TOKEN = 'test-app-password';
  });

  it('TEST 1/2/3 — valid access returns real repository metadata including the default branch (mainbranch.name)', async () => {
    mockFetch((url) => {
      assert.ok(url.includes('myworkspace/myrepo'));
      return { status: 200, body: { mainbranch: { name: 'develop' }, full_name: 'myworkspace/myrepo' } };
    });
    const client = new BitbucketProviderClient();
    await client.validateRemoteAccess('user-1', 'myworkspace', 'myrepo');
    const info = await client.getRepositoryInfo('user-1', 'myworkspace', 'myrepo');
    assert.equal(info.defaultBranch, 'develop');
  });

  it('TEST 5 — classifies a 401 as AUTH_FAILED', async () => {
    mockFetch(() => ({ status: 401, body: { error: { message: 'Unauthorized' } } }));
    const client = new BitbucketProviderClient();
    await assert.rejects(
      () => client.validateRemoteAccess('user-1', 'myworkspace', 'myrepo'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'AUTH_FAILED'); return true; },
    );
  });

  it('TEST 6 — classifies a 404 as NOT_FOUND (repository not found)', async () => {
    mockFetch(() => ({ status: 404, body: { error: { message: 'Repository not found' } } }));
    const client = new BitbucketProviderClient();
    await assert.rejects(
      () => client.validateRemoteAccess('user-1', 'myworkspace', 'does-not-exist'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'NOT_FOUND'); return true; },
    );
  });

  it('TEST 7 — classifies a 403 as RATE_LIMITED (Bitbucket\'s forbidden/quota response)', async () => {
    mockFetch(() => ({ status: 403, body: { error: { message: 'Forbidden' } } }));
    const client = new BitbucketProviderClient();
    await assert.rejects(
      () => client.validateRemoteAccess('user-1', 'myworkspace', 'myrepo'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'RATE_LIMITED'); return true; },
    );
  });

  it('TEST 8 — a generic API failure (500) is surfaced as REQUEST_FAILED, never thrown raw', async () => {
    mockFetch(() => ({ status: 500, body: { error: { message: 'Internal Server Error' } } }));
    const client = new BitbucketProviderClient();
    await assert.rejects(
      () => client.validateRemoteAccess('user-1', 'myworkspace', 'myrepo'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'REQUEST_FAILED'); return true; },
    );
  });

  it('TEST 9 — a malformed response missing mainbranch.name is rejected rather than silently returning undefined', async () => {
    mockFetch(() => ({ status: 200, body: { full_name: 'myworkspace/myrepo' } }));
    const client = new BitbucketProviderClient();
    await assert.rejects(() => client.getRepositoryInfo('user-1', 'myworkspace', 'myrepo'));
  });
});

describe('BitbucketProviderClient — createPullRequest', () => {
  beforeEach(() => {
    process.env.BITBUCKET_USERNAME = 'origami-bot';
    process.env.BITBUCKET_TOKEN = 'test-app-password';
  });

  it('TEST 4 — checks for an existing open PR first, then creates one mapping id/links.html.href onto the generic provider result', async () => {
    let sawLookup = false;
    let sawCreate = false;
    mockFetch((url, init) => {
      if (init.method === 'GET' && url.includes('/pullrequests?q=')) {
        sawLookup = true;
        return { status: 200, body: { values: [] } };
      }
      sawCreate = true;
      const body = JSON.parse(init.body as string);
      assert.equal(body.source.branch.name, 'ai-fix/test');
      assert.equal(body.destination.branch.name, 'main');
      return { status: 201, body: { id: 42, links: { html: { href: 'https://bitbucket.org/myworkspace/myrepo/pull-requests/42' } } } };
    });
    const client = new BitbucketProviderClient();
    const pr = await client.createPullRequest('user-1', { owner: 'myworkspace', repo: 'myrepo', title: 'Fix', body: 'body', head: 'ai-fix/test', base: 'main' });
    assert.ok(sawLookup, 'must check for an existing PR before creating one');
    assert.ok(sawCreate);
    assert.equal(pr.number, 42);
    assert.equal(pr.url, 'https://bitbucket.org/myworkspace/myrepo/pull-requests/42');
    assert.equal(pr.alreadyExisted, false);
  });

  it('an existing open PR for the same head branch is returned instead of creating a duplicate (idempotency)', async () => {
    let createCalls = 0;
    mockFetch((url, init) => {
      if (init.method === 'GET' && url.includes('/pullrequests?q=')) {
        return { status: 200, body: { values: [{ id: 7, links: { html: { href: 'https://bitbucket.org/myworkspace/myrepo/pull-requests/7' } } }] } };
      }
      createCalls += 1;
      return { status: 201, body: { id: 99, links: { html: { href: 'https://x/99' } } } };
    });
    const client = new BitbucketProviderClient();
    const pr = await client.createPullRequest('user-1', { owner: 'myworkspace', repo: 'myrepo', title: 'Fix', body: 'body', head: 'ai-fix/test', base: 'main' });
    assert.equal(pr.number, 7);
    assert.equal(pr.alreadyExisted, true);
    assert.equal(createCalls, 0, 'the create endpoint must never be called when an open PR already exists');
  });

  it('a PR-creation failure is surfaced as a RepositoryProviderError', async () => {
    mockFetch((url, init) => {
      if (init.method === 'GET' && url.includes('/pullrequests?q=')) return { status: 200, body: { values: [] } };
      return { status: 500, body: { error: { message: 'Internal Server Error' } } };
    });
    const client = new BitbucketProviderClient();
    await assert.rejects(
      () => client.createPullRequest('user-1', { owner: 'myworkspace', repo: 'myrepo', title: 'Fix', body: 'body', head: 'ai-fix/test', base: 'main' }),
      (error: unknown) => error instanceof RepositoryProviderError,
    );
  });
});
