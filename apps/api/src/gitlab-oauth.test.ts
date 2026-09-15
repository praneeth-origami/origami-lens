import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitLabOAuthError,
  buildGitLabAuthorizeUrl,
  exchangeGitLabCode,
  fetchGitLabProfile,
  isGitLabOAuthConfigured,
  refreshGitLabToken,
} from './gitlab-oauth.js';

const originalFetch = globalThis.fetch;
const originalEnv = {
  GITLAB_OAUTH_CLIENT_ID: process.env.GITLAB_OAUTH_CLIENT_ID,
  GITLAB_OAUTH_CLIENT_SECRET: process.env.GITLAB_OAUTH_CLIENT_SECRET,
  GITLAB_OAUTH_REDIRECT_URI: process.env.GITLAB_OAUTH_REDIRECT_URI,
};

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

function setConfigured() {
  process.env.GITLAB_OAUTH_CLIENT_ID = 'client-id-123';
  process.env.GITLAB_OAUTH_CLIENT_SECRET = 'client-secret-456';
  process.env.GITLAB_OAUTH_REDIRECT_URI = 'http://localhost:5173/providers/gitlab/callback';
}

function clearConfig() {
  process.env.GITLAB_OAUTH_CLIENT_ID = '';
  process.env.GITLAB_OAUTH_CLIENT_SECRET = '';
  process.env.GITLAB_OAUTH_REDIRECT_URI = '';
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  globalThis.fetch = (async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body } as unknown as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv('GITLAB_OAUTH_CLIENT_ID', originalEnv.GITLAB_OAUTH_CLIENT_ID);
  restoreEnv('GITLAB_OAUTH_CLIENT_SECRET', originalEnv.GITLAB_OAUTH_CLIENT_SECRET);
  restoreEnv('GITLAB_OAUTH_REDIRECT_URI', originalEnv.GITLAB_OAUTH_REDIRECT_URI);
});

describe('gitlab-oauth — configuration', () => {
  it('isGitLabOAuthConfigured is false when any of the three env vars is missing', () => {
    clearConfig();
    assert.equal(isGitLabOAuthConfigured(), false);
    process.env.GITLAB_OAUTH_CLIENT_ID = 'x';
    assert.equal(isGitLabOAuthConfigured(), false);
  });

  it('isGitLabOAuthConfigured is true once all three are set', () => {
    setConfigured();
    assert.equal(isGitLabOAuthConfigured(), true);
  });

  it('buildGitLabAuthorizeUrl throws AUTH_NOT_CONFIGURED (no network) when unconfigured', () => {
    clearConfig();
    assert.throws(() => buildGitLabAuthorizeUrl('state-abc'), (e: unknown) => e instanceof GitLabOAuthError && e.code === 'AUTH_NOT_CONFIGURED');
  });

  it('buildGitLabAuthorizeUrl embeds client_id, redirect_uri, the `api` scope, and the given state — never the client secret', () => {
    setConfigured();
    const url = new URL(buildGitLabAuthorizeUrl('state-abc'));
    assert.equal(url.pathname, '/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'client-id-123');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:5173/providers/gitlab/callback');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('scope'), 'api');
    assert.equal(url.searchParams.get('state'), 'state-abc');
    assert.equal(url.toString().includes('client-secret-456'), false);
  });
});

describe('gitlab-oauth — exchangeGitLabCode', () => {
  it('exchanges a real code for an access/refresh token pair', async () => {
    setConfigured();
    mockFetchSequence([{ status: 200, body: { access_token: 'gl_access', refresh_token: 'gl_refresh', expires_in: 7200 } }]);
    const before = Date.now();
    const tokens = await exchangeGitLabCode('code-xyz');
    assert.equal(tokens.accessToken, 'gl_access');
    assert.equal(tokens.refreshToken, 'gl_refresh');
    const expiresAtMs = new Date(tokens.expiresAt).getTime();
    assert.ok(expiresAtMs >= before + 7199_000 && expiresAtMs <= before + 7201_000);
  });

  it('throws OAUTH_EXCHANGE_FAILED (never leaking the client secret) when GitLab rejects the code', async () => {
    setConfigured();
    mockFetchSequence([{ status: 400, body: { error: 'invalid_grant' } }]);
    await assert.rejects(
      () => exchangeGitLabCode('bad-code'),
      (e: unknown) => {
        assert.ok(e instanceof GitLabOAuthError);
        assert.equal(e.code, 'OAUTH_EXCHANGE_FAILED');
        assert.equal(e.message.includes('client-secret-456'), false);
        return true;
      },
    );
  });

  it('throws AUTH_NOT_CONFIGURED without ever calling fetch when unconfigured', async () => {
    clearConfig();
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error('should not be called'); }) as typeof fetch;
    await assert.rejects(() => exchangeGitLabCode('code-xyz'), (e: unknown) => e instanceof GitLabOAuthError && e.code === 'AUTH_NOT_CONFIGURED');
    assert.equal(called, false);
  });
});

describe('gitlab-oauth — refreshGitLabToken', () => {
  it('returns a NEW rotated access/refresh token pair', async () => {
    setConfigured();
    mockFetchSequence([{ status: 200, body: { access_token: 'gl_access_new', refresh_token: 'gl_refresh_new', expires_in: 7200 } }]);
    const tokens = await refreshGitLabToken('gl_refresh_old');
    assert.equal(tokens.accessToken, 'gl_access_new');
    assert.equal(tokens.refreshToken, 'gl_refresh_new');
    assert.notEqual(tokens.refreshToken, 'gl_refresh_old');
  });

  it('throws OAUTH_EXCHANGE_FAILED when the refresh token itself has been revoked/expired', async () => {
    setConfigured();
    mockFetchSequence([{ status: 400, body: { error: 'invalid_grant' } }]);
    await assert.rejects(() => refreshGitLabToken('revoked-token'), (e: unknown) => e instanceof GitLabOAuthError && e.code === 'OAUTH_EXCHANGE_FAILED');
  });
});

describe('gitlab-oauth — fetchGitLabProfile', () => {
  it('returns the real username, sending the token only as a Bearer header', async () => {
    let capturedAuth = '';
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return { ok: true, status: 200, json: async () => ({ username: 'octocat' }) } as unknown as Response;
    }) as typeof fetch;

    const profile = await fetchGitLabProfile('gl_access_token');
    assert.equal(profile.username, 'octocat');
    assert.equal(capturedAuth, 'Bearer gl_access_token');
  });

  it('throws OAUTH_EXCHANGE_FAILED when GitLab rejects the profile request', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response) as typeof fetch;
    await assert.rejects(() => fetchGitLabProfile('bad-token'), (e: unknown) => e instanceof GitLabOAuthError && e.code === 'OAUTH_EXCHANGE_FAILED');
  });
});
