import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BitbucketOAuthError,
  buildBitbucketAuthorizeUrl,
  exchangeBitbucketCode,
  fetchBitbucketProfile,
  isBitbucketOAuthConfigured,
  refreshBitbucketToken,
} from './bitbucket-oauth.js';

const originalFetch = globalThis.fetch;
const originalEnv = {
  BITBUCKET_OAUTH_CLIENT_ID: process.env.BITBUCKET_OAUTH_CLIENT_ID,
  BITBUCKET_OAUTH_CLIENT_SECRET: process.env.BITBUCKET_OAUTH_CLIENT_SECRET,
  BITBUCKET_OAUTH_REDIRECT_URI: process.env.BITBUCKET_OAUTH_REDIRECT_URI,
};

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

function setConfigured() {
  process.env.BITBUCKET_OAUTH_CLIENT_ID = 'bb-client-id';
  process.env.BITBUCKET_OAUTH_CLIENT_SECRET = 'bb-client-secret';
  process.env.BITBUCKET_OAUTH_REDIRECT_URI = 'http://localhost:5173/providers/bitbucket/callback';
}

function clearConfig() {
  process.env.BITBUCKET_OAUTH_CLIENT_ID = '';
  process.env.BITBUCKET_OAUTH_CLIENT_SECRET = '';
  process.env.BITBUCKET_OAUTH_REDIRECT_URI = '';
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    (mockFetchSequence as unknown as { lastInit?: RequestInit }).lastInit = init;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body } as unknown as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv('BITBUCKET_OAUTH_CLIENT_ID', originalEnv.BITBUCKET_OAUTH_CLIENT_ID);
  restoreEnv('BITBUCKET_OAUTH_CLIENT_SECRET', originalEnv.BITBUCKET_OAUTH_CLIENT_SECRET);
  restoreEnv('BITBUCKET_OAUTH_REDIRECT_URI', originalEnv.BITBUCKET_OAUTH_REDIRECT_URI);
});

describe('bitbucket-oauth — configuration', () => {
  it('isBitbucketOAuthConfigured is false when any of the three env vars is missing', () => {
    clearConfig();
    assert.equal(isBitbucketOAuthConfigured(), false);
    process.env.BITBUCKET_OAUTH_CLIENT_ID = 'x';
    assert.equal(isBitbucketOAuthConfigured(), false);
  });

  it('isBitbucketOAuthConfigured is true once all three are set', () => {
    setConfigured();
    assert.equal(isBitbucketOAuthConfigured(), true);
  });

  it('buildBitbucketAuthorizeUrl throws AUTH_NOT_CONFIGURED (no network) when unconfigured', () => {
    clearConfig();
    assert.throws(() => buildBitbucketAuthorizeUrl('state-abc'), (e: unknown) => e instanceof BitbucketOAuthError && e.code === 'AUTH_NOT_CONFIGURED');
  });

  it('buildBitbucketAuthorizeUrl embeds client_id, the account/repository:write/pullrequest:write scopes, and the given state — never the client secret, and never redirect_uri (Bitbucket resolves it from the consumer config, not the authorize request)', () => {
    setConfigured();
    const url = new URL(buildBitbucketAuthorizeUrl('state-abc'));
    assert.equal(url.hostname, 'bitbucket.org');
    assert.equal(url.pathname, '/site/oauth2/authorize');
    assert.equal(url.searchParams.get('client_id'), 'bb-client-id');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('scope'), 'account repository:write pullrequest:write');
    assert.equal(url.searchParams.get('state'), 'state-abc');
    assert.equal(url.toString().includes('bb-client-secret'), false);
  });
});

describe('bitbucket-oauth — exchangeBitbucketCode', () => {
  it('exchanges a real code for an access/refresh token pair, authenticating via HTTP Basic (client_id:client_secret)', async () => {
    setConfigured();
    mockFetchSequence([{ status: 200, body: { access_token: 'bb_access', refresh_token: 'bb_refresh', expires_in: 7200 } }]);
    const before = Date.now();
    const tokens = await exchangeBitbucketCode('code-xyz');
    assert.equal(tokens.accessToken, 'bb_access');
    assert.equal(tokens.refreshToken, 'bb_refresh');
    const expiresAtMs = new Date(tokens.expiresAt).getTime();
    assert.ok(expiresAtMs >= before + 7199_000 && expiresAtMs <= before + 7201_000);

    const lastInit = (mockFetchSequence as unknown as { lastInit: RequestInit }).lastInit;
    const expectedBasic = `Basic ${Buffer.from('bb-client-id:bb-client-secret').toString('base64')}`;
    assert.equal((lastInit.headers as Record<string, string>).Authorization, expectedBasic);
    assert.equal((lastInit.headers as Record<string, string>)['Content-Type'], 'application/x-www-form-urlencoded');
    assert.ok(!(lastInit.body as string).includes('bb-client-secret'), 'the client secret must never appear in the request body, only the Basic auth header');
  });

  it('throws OAUTH_EXCHANGE_FAILED when Bitbucket returns no refresh_token on the initial exchange (a malformed/unexpected response)', async () => {
    setConfigured();
    mockFetchSequence([{ status: 200, body: { access_token: 'bb_access', expires_in: 7200 } }]);
    await assert.rejects(() => exchangeBitbucketCode('code-xyz'), (e: unknown) => e instanceof BitbucketOAuthError && e.code === 'OAUTH_EXCHANGE_FAILED');
  });

  it('throws OAUTH_EXCHANGE_FAILED (never leaking the client secret) when Bitbucket rejects the code', async () => {
    setConfigured();
    mockFetchSequence([{ status: 400, body: { error: 'invalid_grant' } }]);
    await assert.rejects(
      () => exchangeBitbucketCode('bad-code'),
      (e: unknown) => {
        assert.ok(e instanceof BitbucketOAuthError);
        assert.equal(e.code, 'OAUTH_EXCHANGE_FAILED');
        assert.equal(e.message.includes('bb-client-secret'), false);
        return true;
      },
    );
  });

  it('throws AUTH_NOT_CONFIGURED without ever calling fetch when unconfigured', async () => {
    clearConfig();
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error('should not be called'); }) as typeof fetch;
    await assert.rejects(() => exchangeBitbucketCode('code-xyz'), (e: unknown) => e instanceof BitbucketOAuthError && e.code === 'AUTH_NOT_CONFIGURED');
    assert.equal(called, false);
  });
});

describe('bitbucket-oauth — refreshBitbucketToken', () => {
  it('returns a new access token, and adopts a new refresh token WHEN Bitbucket returns one', async () => {
    setConfigured();
    mockFetchSequence([{ status: 200, body: { access_token: 'bb_access_new', refresh_token: 'bb_refresh_new', expires_in: 7200 } }]);
    const result = await refreshBitbucketToken('bb_refresh_old');
    assert.equal(result.accessToken, 'bb_access_new');
    assert.equal(result.refreshToken, 'bb_refresh_new');
  });

  it('leaves refreshToken undefined when Bitbucket does NOT return a new one (non-mandatory rotation, unlike GitLab)', async () => {
    setConfigured();
    mockFetchSequence([{ status: 200, body: { access_token: 'bb_access_new', expires_in: 7200 } }]);
    const result = await refreshBitbucketToken('bb_refresh_old');
    assert.equal(result.accessToken, 'bb_access_new');
    assert.equal(result.refreshToken, undefined);
  });

  it('throws OAUTH_EXCHANGE_FAILED when the refresh token itself has been revoked/expired', async () => {
    setConfigured();
    mockFetchSequence([{ status: 400, body: { error: 'invalid_grant' } }]);
    await assert.rejects(() => refreshBitbucketToken('revoked-token'), (e: unknown) => e instanceof BitbucketOAuthError && e.code === 'OAUTH_EXCHANGE_FAILED');
  });
});

describe('bitbucket-oauth — fetchBitbucketProfile', () => {
  it('returns the real username, sending the token only as a Bearer header', async () => {
    let capturedAuth = '';
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return { ok: true, status: 200, json: async () => ({ username: 'octocat' }) } as unknown as Response;
    }) as typeof fetch;

    const profile = await fetchBitbucketProfile('bb_access_token');
    assert.equal(profile.username, 'octocat');
    assert.equal(capturedAuth, 'Bearer bb_access_token');
  });

  it('throws OAUTH_EXCHANGE_FAILED when Bitbucket rejects the profile request', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response) as typeof fetch;
    await assert.rejects(() => fetchBitbucketProfile('bad-token'), (e: unknown) => e instanceof BitbucketOAuthError && e.code === 'OAUTH_EXCHANGE_FAILED');
  });
});
