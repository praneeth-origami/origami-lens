/**
 * Bitbucket Cloud OAuth 2.0 (Authorization Code Grant) — Phase 16/E. This
 * is a PROVIDER CONNECTION (repository access/push/PR), never an Origami
 * Lens login mechanism. Follows Bitbucket/Atlassian's actual documented
 * OAuth consumer protocol, which differs from GitLab's in two load-bearing
 * ways this module gets right:
 *
 *  - The token endpoint authenticates via HTTP Basic (base64 client_id:
 *    client_secret), NOT client credentials in the request body, and the
 *    body itself is form-urlencoded, not JSON.
 *  - Bitbucket does not mandate refresh-token rotation on every refresh —
 *    a new refresh_token MAY be returned, and if so it must be adopted; if
 *    absent, the existing refresh_token remains valid and is kept.
 */
const BITBUCKET_OAUTH_HOST = 'https://bitbucket.org';
const BITBUCKET_API_BASE = process.env.BITBUCKET_API_BASE_URL ?? 'https://api.bitbucket.org/2.0';
const USER_AGENT = 'origami-lens-bitbucket-oauth';
const REQUEST_TIMEOUT_MS = 15_000;

export class BitbucketOAuthError extends Error {
  constructor(message: string, public readonly code: 'AUTH_NOT_CONFIGURED' | 'OAUTH_EXCHANGE_FAILED') {
    super(message);
    this.name = 'BitbucketOAuthError';
  }
}

interface BitbucketOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function getBitbucketOAuthConfig(): BitbucketOAuthConfig | undefined {
  const clientId = process.env.BITBUCKET_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.BITBUCKET_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = process.env.BITBUCKET_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return undefined;
  return { clientId, clientSecret, redirectUri };
}

export function isBitbucketOAuthConfigured(): boolean {
  return getBitbucketOAuthConfig() !== undefined;
}

/**
 * `account` (read the connecting user's own profile/username),
 * `repository:write` (repo read/write — Bitbucket's write scopes are a
 * superset of the matching read scope, not an additive pair), and
 * `pullrequest:write` (create/manage PRs, likewise inclusive of PR read) —
 * the narrowest real scope set covering repository access, git push, and
 * PR creation, mirroring GitLab's `api`-is-the-minimal-real-scope
 * reasoning for its own OAuth connection.
 */
const BITBUCKET_OAUTH_SCOPES = 'account repository:write pullrequest:write';

export function buildBitbucketAuthorizeUrl(state: string): string {
  const config = getBitbucketOAuthConfig();
  if (!config) throw new BitbucketOAuthError('Bitbucket OAuth is not configured.', 'AUTH_NOT_CONFIGURED');

  const url = new URL('/site/oauth2/authorize', BITBUCKET_OAUTH_HOST);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', BITBUCKET_OAUTH_SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

export interface BitbucketTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

interface BitbucketTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

async function tokenRequest(config: BitbucketOAuthConfig, body: Record<string, string>): Promise<{ accessToken: string; refreshToken?: string; expiresAt: string }> {
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(new URL('/site/oauth2/access_token', BITBUCKET_OAUTH_HOST), {
      method: 'POST',
      signal: timeoutSignal,
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams(body).toString(),
    });
  } catch {
    throw new BitbucketOAuthError('Bitbucket OAuth token request failed unexpectedly.', 'OAUTH_EXCHANGE_FAILED');
  }

  const json = (await response.json().catch(() => undefined)) as BitbucketTokenResponse | undefined;
  if (!response.ok || !json?.access_token || !json.expires_in) {
    throw new BitbucketOAuthError('Bitbucket OAuth token request was rejected.', 'OAUTH_EXCHANGE_FAILED');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
  };
}

/** Never logs, returns, or otherwise persists the raw code or resulting tokens itself — the caller (provider-connection-service.ts) is responsible for encrypting before any storage. */
export async function exchangeBitbucketCode(code: string): Promise<BitbucketTokenSet> {
  const config = getBitbucketOAuthConfig();
  if (!config) throw new BitbucketOAuthError('Bitbucket OAuth is not configured.', 'AUTH_NOT_CONFIGURED');

  const result = await tokenRequest(config, { code, grant_type: 'authorization_code' });
  // The initial code exchange always returns a refresh_token per Bitbucket's
  // documented contract; a missing one here means the response was
  // malformed, not a legitimate "no refresh token" case.
  if (!result.refreshToken) throw new BitbucketOAuthError('Bitbucket did not return a refresh token.', 'OAUTH_EXCHANGE_FAILED');
  return { accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: result.expiresAt };
}

/**
 * Bitbucket does NOT mandate refresh-token rotation on every use (unlike
 * GitLab) — a new refresh_token MAY be present in the response. The
 * caller must adopt it when present and otherwise keep using the
 * previous one, which is why this returns `refreshToken` as optional
 * rather than always-present.
 */
export async function refreshBitbucketToken(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt: string }> {
  const config = getBitbucketOAuthConfig();
  if (!config) throw new BitbucketOAuthError('Bitbucket OAuth is not configured.', 'AUTH_NOT_CONFIGURED');
  return tokenRequest(config, { refresh_token: refreshToken, grant_type: 'refresh_token' });
}

export interface BitbucketProfile {
  username: string;
}

export async function fetchBitbucketProfile(accessToken: string, signal?: AbortSignal): Promise<BitbucketProfile> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(`${BITBUCKET_API_BASE}/user`, {
      signal: combinedSignal,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
  } catch {
    throw new BitbucketOAuthError('Bitbucket profile request failed unexpectedly.', 'OAUTH_EXCHANGE_FAILED');
  }
  if (!response.ok) throw new BitbucketOAuthError(`Bitbucket profile request failed (${response.status}).`, 'OAUTH_EXCHANGE_FAILED');
  const body = (await response.json().catch(() => ({}))) as { username?: string };
  return { username: body.username ?? 'unknown' };
}
