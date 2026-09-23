import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GitLabProviderClient } from './repository-gitlab-provider-client.js';
import { RepositoryProviderError } from './repository-provider-client.js';

const originalFetch = globalThis.fetch;
const originalToken = process.env.GITLAB_TOKEN;

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
  process.env.GITLAB_TOKEN = originalToken;
});

describe('GitLabProviderClient — configuration / no credential leakage', () => {
  it('TEST 5 — throws AUTH_NOT_CONFIGURED without ever calling fetch when GITLAB_TOKEN is missing', async () => {
    process.env.GITLAB_TOKEN = '';
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error('should not be called'); }) as typeof fetch;

    const client = new GitLabProviderClient();
    await assert.rejects(
      () => client.getRepositoryInfo('user-1', 'octocat', 'Hello-World'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'AUTH_NOT_CONFIGURED'); return true; },
    );
    assert.equal(fetchCalled, false);
  });

  it('getPushCredentials rejects with AUTH_NOT_CONFIGURED (no network) when GITLAB_TOKEN is missing', async () => {
    process.env.GITLAB_TOKEN = '';
    const client = new GitLabProviderClient();
    await assert.rejects(
      () => client.getPushCredentials('user-1', 'group', 'project'),
      (error: unknown) => error instanceof RepositoryProviderError && error.category === 'AUTH_NOT_CONFIGURED',
    );
  });

  it('getPushCredentials returns the documented oauth2/token pair when configured', async () => {
    process.env.GITLAB_TOKEN = 'glpat-secrettoken';
    const client = new GitLabProviderClient();
    const creds = await client.getPushCredentials('user-1', 'group', 'project');
    assert.equal(creds.username, 'oauth2');
    assert.equal(creds.token, 'glpat-secrettoken');
  });

  it('TEST 10 — the token is sent only via the PRIVATE-TOKEN header, and no error message contains it', async () => {
    process.env.GITLAB_TOKEN = 'glpat-supersecrettoken12345';
    let capturedHeaders: Record<string, string> = {};
    mockFetch((url, init) => {
      capturedHeaders = (init.headers ?? {}) as Record<string, string>;
      return { status: 200, body: { default_branch: 'main' } };
    });

    const client = new GitLabProviderClient();
    const info = await client.getRepositoryInfo('user-1', 'octocat', 'Hello-World');
    assert.equal(info.defaultBranch, 'main');
    assert.equal(capturedHeaders['PRIVATE-TOKEN'], 'glpat-supersecrettoken12345');
    assert.equal('Authorization' in capturedHeaders, false);
  });
});

describe('GitLabProviderClient — repository access / metadata', () => {
  beforeEach(() => { process.env.GITLAB_TOKEN = 'test-token'; });

  it('TEST 1/2/3 — valid access returns real project metadata including the default branch', async () => {
    mockFetch((url) => {
      assert.ok(url.includes(encodeURIComponent('org/repository')));
      return { status: 200, body: { default_branch: 'develop', path_with_namespace: 'org/repository' } };
    });
    const client = new GitLabProviderClient();
    await client.validateRemoteAccess('user-1', 'org', 'repository');
    const info = await client.getRepositoryInfo('user-1', 'org', 'repository');
    assert.equal(info.defaultBranch, 'develop');
  });

  it('TEST 5 — classifies a 401 as AUTH_FAILED', async () => {
    mockFetch(() => ({ status: 401, body: { message: '401 Unauthorized' } }));
    const client = new GitLabProviderClient();
    await assert.rejects(
      () => client.validateRemoteAccess('user-1', 'org', 'repository'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'AUTH_FAILED'); return true; },
    );
  });

  it('TEST 6 — classifies a 404 as NOT_FOUND (repository not found)', async () => {
    mockFetch(() => ({ status: 404, body: { message: '404 Project Not Found' } }));
    const client = new GitLabProviderClient();
    await assert.rejects(
      () => client.validateRemoteAccess('user-1', 'org', 'does-not-exist'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'NOT_FOUND'); return true; },
    );
  });

  it('TEST 7 — classifies a 403 as AUTH_FAILED (access denied)', async () => {
    mockFetch(() => ({ status: 403, body: { message: '403 Forbidden' } }));
    const client = new GitLabProviderClient();
    await assert.rejects(
      () => client.validateRemoteAccess('user-1', 'org', 'repository'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'AUTH_FAILED'); return true; },
    );
  });

  it('classifies a 429 as RATE_LIMITED', async () => {
    mockFetch(() => ({ status: 429, body: { message: 'Retry later' } }));
    const client = new GitLabProviderClient();
    await assert.rejects(
      () => client.validateRemoteAccess('user-1', 'org', 'repository'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'RATE_LIMITED'); return true; },
    );
  });

  it('TEST 8 — a generic API failure (500) is surfaced as REQUEST_FAILED, never thrown raw', async () => {
    mockFetch(() => ({ status: 500, body: { message: 'Internal Server Error' } }));
    const client = new GitLabProviderClient();
    await assert.rejects(
      () => client.validateRemoteAccess('user-1', 'org', 'repository'),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'REQUEST_FAILED'); return true; },
    );
  });

  it('TEST 9 — a malformed response missing default_branch is rejected rather than silently returning undefined', async () => {
    mockFetch(() => ({ status: 200, body: { path_with_namespace: 'org/repository' } }));
    const client = new GitLabProviderClient();
    await assert.rejects(() => client.getRepositoryInfo('user-1', 'org', 'repository'));
  });
});

describe('GitLabProviderClient — createPullRequest (Merge Request)', () => {
  beforeEach(() => { process.env.GITLAB_TOKEN = 'test-token'; });

  it('TEST 4 — creates a Merge Request, mapping iid/web_url onto the generic provider result', async () => {
    mockFetch((url, init) => {
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body as string);
      assert.equal(body.source_branch, 'ai-fix/test');
      assert.equal(body.target_branch, 'main');
      return { status: 201, body: { iid: 42, web_url: 'https://gitlab.com/org/repository/-/merge_requests/42' } };
    });
    const client = new GitLabProviderClient();
    const mr = await client.createPullRequest('user-1', { owner: 'org', repo: 'repository', title: 'Fix', body: 'body', head: 'ai-fix/test', base: 'main' });
    assert.equal(mr.number, 42);
    assert.equal(mr.url, 'https://gitlab.com/org/repository/-/merge_requests/42');
    assert.equal(mr.alreadyExisted, false);
  });

  it('a 409 "already exists" response is resolved by looking up and returning the existing open MR (idempotency)', async () => {
    let call = 0;
    mockFetch((url, init) => {
      call += 1;
      if (init.method === 'POST') return { status: 409, body: { message: 'Another open merge request already exists for this source branch: !7' } };
      return { status: 200, body: [{ iid: 7, web_url: 'https://gitlab.com/org/repository/-/merge_requests/7' }] };
    });
    const client = new GitLabProviderClient();
    const mr = await client.createPullRequest('user-1', { owner: 'org', repo: 'repository', title: 'Fix', body: 'body', head: 'ai-fix/test', base: 'main' });
    assert.equal(mr.number, 7);
    assert.equal(mr.alreadyExisted, true);
    assert.equal(call, 2);
  });

  it('an MR-creation failure is surfaced as a RepositoryProviderError', async () => {
    mockFetch(() => ({ status: 500, body: { message: 'Internal Server Error' } }));
    const client = new GitLabProviderClient();
    await assert.rejects(
      () => client.createPullRequest('user-1', { owner: 'org', repo: 'repository', title: 'Fix', body: 'body', head: 'ai-fix/test', base: 'main' }),
      (error: unknown) => error instanceof RepositoryProviderError,
    );
  });
});
