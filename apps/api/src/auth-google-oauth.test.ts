import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GoogleOAuthError,
  buildGoogleAuthorizeUrl,
  completeGoogleOAuthLogin,
  isGoogleOAuthConfigured,
} from './auth-google-oauth.js';

const originalFetch = globalThis.fetch;
const originalEnv = {
  GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_CALLBACK_URL: process.env.GOOGLE_OAUTH_CALLBACK_URL,
};

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function setConfigured() {
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id-123';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-456';
  process.env.GOOGLE_OAUTH_CALLBACK_URL = 'http://localhost:5173/auth/google/callback';
}

function clearConfig() {
  process.env.GOOGLE_OAUTH_CLIENT_ID = '';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = '';
  process.env.GOOGLE_OAUTH_CALLBACK_URL = '';
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  const inits: RequestInit[] = [];
  (mockFetchSequence as unknown as { inits: RequestInit[] }).inits = inits;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (init) inits.push(init);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    } as unknown as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv('GOOGLE_OAUTH_CLIENT_ID', originalEnv.GOOGLE_OAUTH_CLIENT_ID);
  restoreEnv('GOOGLE_OAUTH_CLIENT_SECRET', originalEnv.GOOGLE_OAUTH_CLIENT_SECRET);
  restoreEnv('GOOGLE_OAUTH_CALLBACK_URL', originalEnv.GOOGLE_OAUTH_CALLBACK_URL);
});

describe('auth-google-oauth — configuration', () => {
  it('isGoogleOAuthConfigured is false when any of the three env vars is missing', () => {
    clearConfig();
    assert.equal(isGoogleOAuthConfigured(), false);
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'x';
    assert.equal(isGoogleOAuthConfigured(), false);
  });

  it('isGoogleOAuthConfigured is true once all three are set', () => {
    setConfigured();
    assert.equal(isGoogleOAuthConfigured(), true);
  });

  it('buildGoogleAuthorizeUrl throws AUTH_NOT_CONFIGURED (no network) when unconfigured', () => {
    clearConfig();
    assert.throws(() => buildGoogleAuthorizeUrl('state-abc'), (error: unknown) => error instanceof GoogleOAuthError && error.code === 'AUTH_NOT_CONFIGURED');
  });

  it('buildGoogleAuthorizeUrl embeds client_id, redirect_uri, the OIDC scope, response_type=code, and the given state — never the client secret', () => {
    setConfigured();
    const url = new URL(buildGoogleAuthorizeUrl('state-abc'));
    assert.equal(url.hostname, 'accounts.google.com');
    assert.equal(url.searchParams.get('client_id'), 'client-id-123');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:5173/auth/google/callback');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('scope'), 'openid email profile');
    assert.equal(url.searchParams.get('state'), 'state-abc');
    assert.equal(url.toString().includes('client-secret-456'), false);
  });
});

describe('auth-google-oauth — completeGoogleOAuthLogin', () => {
  it('exchanges the code (form-urlencoded, per Google\'s documented token endpoint) and returns the profile keyed by the stable "sub", never email', async () => {
    setConfigured();
    mockFetchSequence([
      { status: 200, body: { access_token: 'ya29.token' } },
      { status: 200, body: { sub: '110169484474386276334', email: 'jane@example.com', name: 'Jane Doe', picture: 'https://example.com/a.png' } },
    ]);

    const profile = await completeGoogleOAuthLogin('code-xyz');
    assert.equal(profile.id, '110169484474386276334');
    assert.equal(profile.email, 'jane@example.com');
    assert.equal(profile.name, 'Jane Doe');
    assert.equal(profile.avatarUrl, 'https://example.com/a.png');

    const tokenRequestInit = (mockFetchSequence as unknown as { inits: RequestInit[] }).inits[0];
    assert.equal((tokenRequestInit.headers as Record<string, string>)['Content-Type'], 'application/x-www-form-urlencoded');
  });

  it('never sends the access token anywhere except the Authorization header of the userinfo request', async () => {
    setConfigured();
    let capturedAuth = '';
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.secret-token' }) } as unknown as Response;
      }
      capturedAuth = (init?.headers as Record<string, string>).Authorization;
      return { ok: true, status: 200, json: async () => ({ sub: '1', email: null, name: null, picture: null }) } as unknown as Response;
    }) as typeof fetch;

    await completeGoogleOAuthLogin('code-xyz');
    assert.equal(capturedAuth, 'Bearer ya29.secret-token');
  });

  it('throws OAUTH_EXCHANGE_FAILED (never leaking the client secret) when Google rejects the code', async () => {
    setConfigured();
    mockFetchSequence([{ status: 400, body: { error: 'invalid_grant' } }]);

    await assert.rejects(
      () => completeGoogleOAuthLogin('bad-code'),
      (error: unknown) => {
        assert.ok(error instanceof GoogleOAuthError);
        assert.equal(error.code, 'OAUTH_EXCHANGE_FAILED');
        assert.equal(error.message.includes('client-secret-456'), false);
        return true;
      },
    );
  });

  it('throws OAUTH_EXCHANGE_FAILED when Google does not report a stable account id (sub)', async () => {
    setConfigured();
    mockFetchSequence([
      { status: 200, body: { access_token: 'ya29.token' } },
      { status: 200, body: { email: 'jane@example.com', name: 'Jane Doe' } },
    ]);

    await assert.rejects(() => completeGoogleOAuthLogin('code-xyz'), (error: unknown) => error instanceof GoogleOAuthError && error.code === 'OAUTH_EXCHANGE_FAILED');
  });

  it('throws AUTH_NOT_CONFIGURED without ever calling fetch when unconfigured', async () => {
    clearConfig();
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error('should not be called'); }) as typeof fetch;

    await assert.rejects(() => completeGoogleOAuthLogin('code-xyz'), (error: unknown) => error instanceof GoogleOAuthError && error.code === 'AUTH_NOT_CONFIGURED');
    assert.equal(fetchCalled, false);
  });
});
