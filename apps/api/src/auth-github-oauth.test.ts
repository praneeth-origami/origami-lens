import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubOAuthError,
  buildGitHubAuthorizeUrl,
  completeGitHubOAuthLogin,
  isGitHubOAuthConfigured,
} from './auth-github-oauth.js';

const originalFetch = globalThis.fetch;
const originalEnv = {
  GITHUB_OAUTH_CLIENT_ID: process.env.GITHUB_OAUTH_CLIENT_ID,
  GITHUB_OAUTH_CLIENT_SECRET: process.env.GITHUB_OAUTH_CLIENT_SECRET,
  GITHUB_OAUTH_CALLBACK_URL: process.env.GITHUB_OAUTH_CALLBACK_URL,
};

function setConfigured() {
  process.env.GITHUB_OAUTH_CLIENT_ID = 'client-id-123';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'client-secret-456';
  process.env.GITHUB_OAUTH_CALLBACK_URL = 'http://localhost:5173/auth/github/callback';
}

function clearConfig() {
  process.env.GITHUB_OAUTH_CLIENT_ID = '';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = '';
  process.env.GITHUB_OAUTH_CALLBACK_URL = '';
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  globalThis.fetch = (async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    } as unknown as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.GITHUB_OAUTH_CLIENT_ID = originalEnv.GITHUB_OAUTH_CLIENT_ID;
  process.env.GITHUB_OAUTH_CLIENT_SECRET = originalEnv.GITHUB_OAUTH_CLIENT_SECRET;
  process.env.GITHUB_OAUTH_CALLBACK_URL = originalEnv.GITHUB_OAUTH_CALLBACK_URL;
});

describe('auth-github-oauth — configuration', () => {
  it('isGitHubOAuthConfigured is false when any of the three env vars is missing', () => {
    clearConfig();
    assert.equal(isGitHubOAuthConfigured(), false);
    process.env.GITHUB_OAUTH_CLIENT_ID = 'x';
    assert.equal(isGitHubOAuthConfigured(), false);
  });

  it('isGitHubOAuthConfigured is true once all three are set', () => {
    setConfigured();
    assert.equal(isGitHubOAuthConfigured(), true);
  });

  it('buildGitHubAuthorizeUrl throws AUTH_NOT_CONFIGURED (no network) when unconfigured', () => {
    clearConfig();
    assert.throws(() => buildGitHubAuthorizeUrl('state-abc'), (error: unknown) => error instanceof GitHubOAuthError && error.code === 'AUTH_NOT_CONFIGURED');
  });

  it('buildGitHubAuthorizeUrl embeds client_id, redirect_uri, a minimal scope, and the given state — never the client secret', () => {
    setConfigured();
    const url = new URL(buildGitHubAuthorizeUrl('state-abc'));
    assert.equal(url.searchParams.get('client_id'), 'client-id-123');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:5173/auth/github/callback');
    assert.equal(url.searchParams.get('scope'), 'read:user user:email');
    assert.equal(url.searchParams.get('state'), 'state-abc');
    assert.equal(url.toString().includes('client-secret-456'), false);
  });
});

describe('auth-github-oauth — completeGitHubOAuthLogin', () => {
  it('exchanges the code and returns the profile on success (public email present)', async () => {
    setConfigured();
    mockFetchSequence([
      { status: 200, body: { access_token: 'gho_token' } },
      { status: 200, body: { id: 42, login: 'octocat', email: 'octocat@example.com', name: 'The Octocat', avatar_url: 'https://example.com/a.png' } },
    ]);

    const profile = await completeGitHubOAuthLogin('code-xyz');
    assert.equal(profile.id, 42);
    assert.equal(profile.login, 'octocat');
    assert.equal(profile.email, 'octocat@example.com');
  });

  it('falls back to /user/emails when the public email is null, using the primary verified address', async () => {
    setConfigured();
    mockFetchSequence([
      { status: 200, body: { access_token: 'gho_token' } },
      { status: 200, body: { id: 42, login: 'octocat', email: null, name: null, avatar_url: null } },
      { status: 200, body: [{ email: 'secondary@example.com', primary: false, verified: true }, { email: 'primary@example.com', primary: true, verified: true }] },
    ]);

    const profile = await completeGitHubOAuthLogin('code-xyz');
    assert.equal(profile.email, 'primary@example.com');
  });

  it('throws OAUTH_EXCHANGE_FAILED (never leaking the client secret) when GitHub rejects the code', async () => {
    setConfigured();
    mockFetchSequence([{ status: 401, body: { error: 'bad_verification_code' } }]);

    await assert.rejects(
      () => completeGitHubOAuthLogin('bad-code'),
      (error: unknown) => {
        assert.ok(error instanceof GitHubOAuthError);
        assert.equal(error.code, 'OAUTH_EXCHANGE_FAILED');
        assert.equal(error.message.includes('client-secret-456'), false);
        return true;
      },
    );
  });

  it('throws AUTH_NOT_CONFIGURED without ever calling fetch when unconfigured', async () => {
    clearConfig();
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error('should not be called'); }) as typeof fetch;

    await assert.rejects(() => completeGitHubOAuthLogin('code-xyz'), (error: unknown) => error instanceof GitHubOAuthError && error.code === 'AUTH_NOT_CONFIGURED');
    assert.equal(fetchCalled, false);
  });
});
