/**
 * GitHub OAuth (classic Authorization Code flow, `repo` scope) — a PROVIDER
 * CONNECTION (direct push / fork + PR access for a repository the Origami
 * Lens GitHub App is NOT installed on), never an Origami Lens login
 * mechanism. Deliberately a SEPARATE OAuth App from both:
 *  - auth-github-oauth.ts (login only, `read:user user:email`, token
 *    discarded immediately — never touches a repository), and
 *  - github-app-auth.ts (the GitHub App itself — installation-bound tokens
 *    that can never reach a repo the App isn't installed on, which is
 *    exactly the gap this module exists to close).
 * Classic GitHub OAuth App tokens do not expire and have no refresh token
 * (unless the OAuth App opts into token expiration, which this integration
 * does not require) — same shape as gitlab-oauth.ts's GitLabTokenSet, minus
 * the mandatory refresh/expiry fields, so the persisted connection has no
 * rotation to manage. Nothing here ever persists a token itself; that's
 * provider-connection-service.ts's job (encrypted via credential-encryption.ts).
 */
const GITHUB_API_BASE = process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com';
const USER_AGENT = 'origami-lens-github-push-oauth';
const REQUEST_TIMEOUT_MS = 15_000;

export class GitHubPushOAuthError extends Error {
  constructor(message: string, public readonly code: 'AUTH_NOT_CONFIGURED' | 'OAUTH_EXCHANGE_FAILED') {
    super(message);
    this.name = 'GitHubPushOAuthError';
  }
}

interface GitHubPushOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function getGitHubPushOAuthConfig(): GitHubPushOAuthConfig | undefined {
  const clientId = process.env.GITHUB_PUSH_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_PUSH_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GITHUB_PUSH_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return undefined;
  return { clientId, clientSecret, redirectUri };
}

export function isGitHubPushOAuthConfigured(): boolean {
  return getGitHubPushOAuthConfig() !== undefined;
}

/** `repo` is GitHub's own scope for "full control of private and public repositories" — the narrowest classic scope that covers both pushing a branch and opening a PR against a repo the user has write access to, or forking + PRing one they only have read access to. */
export function buildGitHubPushAuthorizeUrl(state: string): string {
  const config = getGitHubPushOAuthConfig();
  if (!config) throw new GitHubPushOAuthError('GitHub direct-push authorization is not configured.', 'AUTH_NOT_CONFIGURED');

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', 'repo');
  url.searchParams.set('state', state);
  return url.toString();
}

export interface GitHubPushTokenSet {
  accessToken: string;
}

/** Never logs, returns, or otherwise persists the raw code or resulting token itself — the caller (provider-connection-service.ts) is responsible for encrypting before any storage. */
export async function exchangeGitHubPushCode(code: string, signal?: AbortSignal): Promise<GitHubPushTokenSet> {
  const config = getGitHubPushOAuthConfig();
  if (!config) throw new GitHubPushOAuthError('GitHub direct-push authorization is not configured.', 'AUTH_NOT_CONFIGURED');

  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      signal: combinedSignal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
      }),
    });
  } catch {
    throw new GitHubPushOAuthError('GitHub OAuth token exchange failed unexpectedly.', 'OAUTH_EXCHANGE_FAILED');
  }

  const json = (await response.json().catch(() => undefined)) as { access_token?: string; error?: string } | undefined;
  if (!response.ok || !json?.access_token) {
    throw new GitHubPushOAuthError('GitHub OAuth token exchange was rejected.', 'OAUTH_EXCHANGE_FAILED');
  }
  return { accessToken: json.access_token };
}

export interface GitHubPushProfile {
  login: string;
}

export async function fetchGitHubPushProfile(accessToken: string, signal?: AbortSignal): Promise<GitHubPushProfile> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(`${GITHUB_API_BASE}/user`, {
      signal: combinedSignal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
      },
    });
  } catch {
    throw new GitHubPushOAuthError('GitHub profile request failed unexpectedly.', 'OAUTH_EXCHANGE_FAILED');
  }
  if (!response.ok) throw new GitHubPushOAuthError(`GitHub profile request failed (${response.status}).`, 'OAUTH_EXCHANGE_FAILED');
  const body = (await response.json().catch(() => ({}))) as { login?: string };
  return { login: body.login ?? 'unknown' };
}
