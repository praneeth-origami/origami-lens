/**
 * GitLab OAuth (Authorization Code flow, real 3-legged OAuth with a
 * rotating refresh token) — Phase 16/D. This is a PROVIDER CONNECTION
 * (repository access/push/MR), never an Origami Lens login mechanism —
 * distinct from auth-github-oauth.ts, which only ever identifies "who is
 * this human." Nothing here ever persists a token itself; that's
 * provider-connection-service.ts's job (encrypted via credential-encryption.ts).
 */
const GITLAB_OAUTH_HOST = process.env.GITLAB_API_BASE_URL?.replace(/\/api\/v4\/?$/, '') ?? 'https://gitlab.com';
const GITLAB_API_BASE = process.env.GITLAB_API_BASE_URL ?? 'https://gitlab.com/api/v4';
const USER_AGENT = 'origami-lens-gitlab-oauth';
const REQUEST_TIMEOUT_MS = 15_000;

export class GitLabOAuthError extends Error {
  constructor(message: string, public readonly code: 'AUTH_NOT_CONFIGURED' | 'OAUTH_EXCHANGE_FAILED') {
    super(message);
    this.name = 'GitLabOAuthError';
  }
}

interface GitLabOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function getGitLabOAuthConfig(): GitLabOAuthConfig | undefined {
  const clientId = process.env.GITLAB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GITLAB_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GITLAB_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return undefined;
  return { clientId, clientSecret, redirectUri };
}

export function isGitLabOAuthConfigured(): boolean {
  return getGitLabOAuthConfig() !== undefined;
}

/**
 * `api` is the narrowest real GitLab scope that covers both what this
 * workflow needs: creating/looking up Merge Requests via the REST API
 * (read_api/api) AND pushing over HTTPS (read_repository/write_repository)
 * — GitLab has no combined scope narrower than `api` that covers both.
 */
export function buildGitLabAuthorizeUrl(state: string): string {
  const config = getGitLabOAuthConfig();
  if (!config) throw new GitLabOAuthError('GitLab OAuth is not configured.', 'AUTH_NOT_CONFIGURED');

  const url = new URL('/oauth/authorize', GITLAB_OAUTH_HOST);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'api');
  url.searchParams.set('state', state);
  return url.toString();
}

export interface GitLabTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

interface GitLabTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<GitLabTokenSet> {
  const config = getGitLabOAuthConfig();
  if (!config) throw new GitLabOAuthError('GitLab OAuth is not configured.', 'AUTH_NOT_CONFIGURED');

  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(new URL('/oauth/token', GITLAB_OAUTH_HOST), {
      method: 'POST',
      signal: timeoutSignal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, ...body }),
    });
  } catch {
    throw new GitLabOAuthError('GitLab OAuth token request failed unexpectedly.', 'OAUTH_EXCHANGE_FAILED');
  }

  const json = (await response.json().catch(() => undefined)) as GitLabTokenResponse | undefined;
  if (!response.ok || !json?.access_token || !json.refresh_token || !json.expires_in) {
    throw new GitLabOAuthError('GitLab OAuth token request was rejected.', 'OAUTH_EXCHANGE_FAILED');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
  };
}

/** Never logs, returns, or otherwise persists the raw code or resulting tokens itself — the caller (provider-connection-service.ts) is responsible for encrypting before any storage. */
export async function exchangeGitLabCode(code: string): Promise<GitLabTokenSet> {
  const config = getGitLabOAuthConfig();
  if (!config) throw new GitLabOAuthError('GitLab OAuth is not configured.', 'AUTH_NOT_CONFIGURED');
  return tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: config.redirectUri });
}

/** GitLab ALWAYS rotates the refresh token on use — the caller must persist the NEW refresh token returned here, never reuse the old one. */
export async function refreshGitLabToken(refreshToken: string): Promise<GitLabTokenSet> {
  return tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
}

export interface GitLabProfile {
  username: string;
}

export async function fetchGitLabProfile(accessToken: string, signal?: AbortSignal): Promise<GitLabProfile> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(`${GITLAB_API_BASE}/user`, {
      signal: combinedSignal,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
  } catch {
    throw new GitLabOAuthError('GitLab profile request failed unexpectedly.', 'OAUTH_EXCHANGE_FAILED');
  }
  if (!response.ok) throw new GitLabOAuthError(`GitLab profile request failed (${response.status}).`, 'OAUTH_EXCHANGE_FAILED');
  const body = (await response.json().catch(() => ({}))) as { username?: string };
  return { username: body.username ?? 'unknown' };
}
