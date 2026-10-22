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

/** Routes by URL substring + method, in order — the first matching entry handles the call. Used for resolvePrStrategy tests, which make several distinct GitHub API calls in sequence (repo permissions, fork creation, fork readiness poll). */
function mockFetchByUrl(routes: Array<{ test: RegExp; method?: string; respond: (url: string, init: RequestInit) => { status: number; body: unknown } }>) {
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const route = routes.find((r) => r.test.test(url) && (!r.method || (init.method ?? 'GET') === r.method));
    if (!route) throw new Error(`No mock route for ${init.method ?? 'GET'} ${url}`);
    const { status, body } = route.respond(url, init);
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

  it('a fork PR (headOwner set, different from owner) formats head as "headOwner:branch" and calls createPullRequest against the BASE repo, never the fork', async () => {
    mockFetch((url, init) => {
      assert.match(url, /\/repos\/acme-corp\/widgets\/pulls$/, 'must POST to the base repo, not the fork');
      const body = JSON.parse(init.body as string);
      assert.equal(body.head, 'my-fork-user:ai-fix/test');
      assert.equal(body.base, 'main');
      return { status: 201, body: { number: 9, html_url: 'https://github.com/acme-corp/widgets/pull/9' } };
    });
    const client = new GitHubProviderClient();
    const pr = await client.createPullRequest('user-1', {
      owner: 'acme-corp', repo: 'widgets', title: 'Fix', body: 'body', head: 'ai-fix/test', base: 'main', headOwner: 'my-fork-user',
    });
    assert.equal(pr.number, 9);
  });

  it('an explicit authToken is used verbatim instead of GITHUB_TOKEN/the App path', async () => {
    process.env.GITHUB_TOKEN = 'should-not-be-used';
    let capturedAuth = '';
    mockFetch((url, init) => {
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return { status: 201, body: { number: 1, html_url: 'https://github.com/octocat/Hello-World/pull/1' } };
    });
    const client = new GitHubProviderClient();
    await client.createPullRequest('user-1', {
      owner: 'octocat', repo: 'Hello-World', title: 'Fix', body: 'body', head: 'ai-fix/test', base: 'main', authToken: 'user-oauth-token-xyz',
    });
    assert.equal(capturedAuth, 'Bearer user-oauth-token-xyz');
  });
});

describe('GitHubProviderClient — createIssue (roadmap Phase 7 — distinct from createPullRequest, never a branch/commit/PR)', () => {
  beforeEach(() => { process.env.GITHUB_TOKEN = 'test-token'; });

  it('creates an issue and returns its number/url', async () => {
    mockFetch((url, init) => {
      assert.match(url, /\/repos\/octocat\/Hello-World\/issues$/);
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body as string);
      assert.equal(body.title, 'Empty button');
      assert.deepEqual(body.labels, ['accessibility', 'high']);
      return { status: 201, body: { number: 7, html_url: 'https://github.com/octocat/Hello-World/issues/7' } };
    });
    const client = new GitHubProviderClient();
    const result = await client.createIssue('user-1', { owner: 'octocat', repo: 'Hello-World', title: 'Empty button', body: 'body text', labels: ['accessibility', 'high'] });
    assert.equal(result.number, 7);
    assert.equal(result.url, 'https://github.com/octocat/Hello-World/issues/7');
  });

  it('a request failure is surfaced as a RepositoryProviderError, never thrown raw', async () => {
    mockFetch(() => ({ status: 500, body: { message: 'Internal Server Error' } }));
    const client = new GitHubProviderClient();
    await assert.rejects(
      () => client.createIssue('user-1', { owner: 'octocat', repo: 'Hello-World', title: 'Fix', body: 'body' }),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); return true; },
    );
  });

  it('a 403 (missing "Issues: write" App permission, or a real rate limit) is classified the same way createPullRequest already classifies a 403', async () => {
    mockFetch(() => ({ status: 403, body: { message: 'Resource not accessible by integration' } }));
    const client = new GitHubProviderClient();
    await assert.rejects(
      () => client.createIssue('user-1', { owner: 'octocat', repo: 'Hello-World', title: 'Fix', body: 'body' }),
      (error: unknown) => { assert.ok(error instanceof RepositoryProviderError); assert.equal(error.category, 'RATE_LIMITED'); return true; },
    );
  });
});

describe('GitHubProviderClient — resolvePrStrategy (non-admin PR creation)', () => {
  const originalAppId = process.env.GITHUB_APP_ID;
  const originalAppKey = process.env.GITHUB_APP_PRIVATE_KEY;

  beforeEach(() => {
    // Isolate every test from the App/GITHUB_TOKEN paths by default — each
    // test opts back into whichever path it's specifically exercising.
    process.env.GITHUB_APP_ID = '';
    process.env.GITHUB_APP_PRIVATE_KEY = '';
    process.env.GITHUB_TOKEN = '';
  });

  afterEach(() => {
    if (originalAppId === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = originalAppId;
    if (originalAppKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = originalAppKey;
  });

  it('GITHUB_APP_DIRECT — the existing (env-token-fallback) App path is tried first and used unchanged when it succeeds', async () => {
    process.env.GITHUB_TOKEN = 'ghp_realtoken';
    let userTokenResolverCalled = false;
    const client = new GitHubProviderClient({ resolveUserPushToken: async () => { userTokenResolverCalled = true; return 'unused'; } });

    const result = await client.resolvePrStrategy('user-1', 'octocat', 'Hello-World');
    assert.equal(result.strategy, 'GITHUB_APP_DIRECT');
    assert.equal(result.pushCredentials?.token, 'ghp_realtoken');
    assert.equal(userTokenResolverCalled, false, 'the App path succeeded — the user-OAuth fallback must never even be consulted');
  });

  it('USER_DIRECT — App path unusable (no App, no GITHUB_TOKEN) + the user has push access on this exact repo', async () => {
    const client = new GitHubProviderClient({ resolveUserPushToken: async () => 'user-oauth-token' });
    mockFetchByUrl([
      {
        test: /\/repos\/acme-corp\/widgets$/,
        respond: (_url, init) => {
          assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer user-oauth-token');
          return { status: 200, body: { permissions: { push: true }, allow_forking: true, default_branch: 'develop' } };
        },
      },
    ]);

    const result = await client.resolvePrStrategy('user-1', 'acme-corp', 'widgets');
    assert.equal(result.strategy, 'USER_DIRECT');
    assert.equal(result.pushCredentials?.token, 'user-oauth-token');
    assert.equal(result.defaultBranch, 'develop');
  });

  it('USER_FORK — read-only access but forking allowed: creates (or reuses) a fork and reports it once ready', async () => {
    const client = new GitHubProviderClient({ resolveUserPushToken: async () => 'user-oauth-token' });
    mockFetchByUrl([
      { test: /\/repos\/acme-corp\/widgets$/, respond: () => ({ status: 200, body: { permissions: { push: false }, allow_forking: true, default_branch: 'main' } }) },
      { test: /\/forks$/, method: 'POST', respond: () => ({ status: 202, body: { owner: { login: 'dev-user' }, clone_url: 'https://github.com/dev-user/widgets.git' } }) },
      { test: /\/repos\/dev-user\/widgets$/, respond: () => ({ status: 200, body: { full_name: 'dev-user/widgets' } }) },
    ]);

    const result = await client.resolvePrStrategy('user-1', 'acme-corp', 'widgets');
    assert.equal(result.strategy, 'USER_FORK');
    assert.equal(result.forkOwner, 'dev-user');
    assert.equal(result.forkCloneUrl, 'https://github.com/dev-user/widgets.git');
    assert.equal(result.pushCredentials?.token, 'user-oauth-token');
  });

  it('USER_FORK preview mode never creates a fork — reports the strategy only', async () => {
    let forkPostCalled = false;
    const client = new GitHubProviderClient({ resolveUserPushToken: async () => 'user-oauth-token' });
    mockFetchByUrl([
      { test: /\/repos\/acme-corp\/widgets$/, respond: () => ({ status: 200, body: { permissions: { push: false }, allow_forking: true, default_branch: 'main' } }) },
      { test: /\/forks$/, method: 'POST', respond: () => { forkPostCalled = true; return { status: 202, body: {} }; } },
    ]);

    const result = await client.resolvePrStrategy('user-1', 'acme-corp', 'widgets', undefined, { preview: true });
    assert.equal(result.strategy, 'USER_FORK');
    assert.equal(result.pushCredentials, undefined, 'preview must not resolve real push credentials either');
    assert.equal(forkPostCalled, false, 'preview must never actually create a fork');
  });

  it('ADMIN_APPROVAL_REQUIRED — read-only access AND forking disabled by the organization', async () => {
    const client = new GitHubProviderClient({ resolveUserPushToken: async () => 'user-oauth-token' });
    mockFetchByUrl([
      { test: /\/repos\/acme-corp\/widgets$/, respond: () => ({ status: 200, body: { permissions: { push: false }, allow_forking: false, default_branch: 'main' } }) },
    ]);

    const result = await client.resolvePrStrategy('user-1', 'acme-corp', 'widgets');
    assert.equal(result.strategy, 'ADMIN_APPROVAL_REQUIRED');
    assert.ok(result.detail.length > 0);
    assert.equal(result.pushCredentials, undefined);
  });

  it('ADMIN_APPROVAL_REQUIRED — no App AND the user has never connected GitHub for direct push access', async () => {
    const client = new GitHubProviderClient({ resolveUserPushToken: async () => undefined });
    const result = await client.resolvePrStrategy('user-1', 'acme-corp', 'widgets');
    assert.equal(result.strategy, 'ADMIN_APPROVAL_REQUIRED');
    assert.match(result.detail, /App is not installed|connect|administrator/i);
  });

  it('ADMIN_APPROVAL_REQUIRED — the user has a direct-push connection but cannot even see this repository (404)', async () => {
    const client = new GitHubProviderClient({ resolveUserPushToken: async () => 'user-oauth-token' });
    mockFetchByUrl([{ test: /\/repos\/acme-corp\/widgets$/, respond: () => ({ status: 404, body: { message: 'Not Found' } }) }]);

    const result = await client.resolvePrStrategy('user-1', 'acme-corp', 'widgets');
    assert.equal(result.strategy, 'ADMIN_APPROVAL_REQUIRED');
  });

  it('multi-repo isolation — the SAME user resolves DIFFERENT strategies for two different repos in one run (App-installed repo vs. not)', async () => {
    process.env.GITHUB_TOKEN = 'ghp_realtoken'; // App path "succeeds" (env fallback) for repo A
    const client = new GitHubProviderClient({ resolveUserPushToken: async () => 'user-oauth-token' });

    const repoA = await client.resolvePrStrategy('user-1', 'personal-account', 'repo-a');
    assert.equal(repoA.strategy, 'GITHUB_APP_DIRECT');

    // Simulate "App path no longer available" for repo B by clearing GITHUB_TOKEN and re-resolving —
    // proves resolution is genuinely per-call, not cached/sticky from repo A's resolution.
    process.env.GITHUB_TOKEN = '';
    mockFetchByUrl([{ test: /\/repos\/acme-corp\/repo-b$/, respond: () => ({ status: 200, body: { permissions: { push: true }, allow_forking: true, default_branch: 'main' } }) }]);
    const repoB = await client.resolvePrStrategy('user-1', 'acme-corp', 'repo-b');
    assert.equal(repoB.strategy, 'USER_DIRECT');
  });
});
