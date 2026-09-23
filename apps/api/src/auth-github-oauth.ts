/**
 * GitHub OAuth (Authorization Code flow) for Origami Lens's own login —
 * distinct from repository-github-provider-client.ts, which is about
 * per-repository Git access (Phase 12-14), not "who is this human." This
 * module never touches a repository, branch, commit, or PR — it only ever
 * calls github.com's OAuth token endpoint and the /user profile endpoint.
 *
 * Read fresh from process.env on every call (matching this project's
 * pool.ts/GITHUB_TOKEN convention) so tests can toggle configuration via
 * process.env without re-importing.
 */

const GITHUB_API_BASE = process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com';
const USER_AGENT = 'origami-lens-auth';
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

export class GitHubOAuthError extends Error {
  constructor(message: string, public readonly code: 'AUTH_NOT_CONFIGURED' | 'OAUTH_EXCHANGE_FAILED') {
    super(message);
    this.name = 'GitHubOAuthError';
  }
}

interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export function getGitHubOAuthConfig(): GitHubOAuthConfig | undefined {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
  const callbackUrl = process.env.GITHUB_OAUTH_CALLBACK_URL?.trim();
  if (!clientId || !clientSecret || !callbackUrl) return undefined;
  return { clientId, clientSecret, callbackUrl };
}

export function isGitHubOAuthConfigured(): boolean {
  return getGitHubOAuthConfig() !== undefined;
}

/** `state` is generated and verified entirely by the caller (auth-service.ts) via the double-submit cookie pattern — this function just forwards it. */
export function buildGitHubAuthorizeUrl(state: string): string {
  const config = getGitHubOAuthConfig();
  if (!config) throw new GitHubOAuthError('GitHub OAuth login is not configured.', 'AUTH_NOT_CONFIGURED');

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.callbackUrl);
  // read:user for profile fields, user:email for a verified email address
  // when the user's public email is empty — no repository/org/write scopes
  // of any kind; this token is only ever used for the /user profile lookup
  // below and is discarded immediately after (see auth-service.ts).
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  return url.toString();
}

export interface GitHubProfile {
  id: number;
  login: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

/** Never logs, returns, or otherwise persists the access token — it is used in-memory for the immediately-following profile fetch and then discarded. */
export async function completeGitHubOAuthLogin(code: string, signal?: AbortSignal): Promise<GitHubProfile> {
  const config = getGitHubOAuthConfig();
  if (!config) throw new GitHubOAuthError('GitHub OAuth login is not configured.', 'AUTH_NOT_CONFIGURED');

  const timeoutSignal = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const accessToken = await exchangeCodeForAccessToken(config, code, combinedSignal);
  return fetchGitHubProfile(accessToken, combinedSignal);
}

async function exchangeCodeForAccessToken(config: GitHubOAuthConfig, code: string, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.callbackUrl,
      }),
    });
  } catch {
    throw new GitHubOAuthError('GitHub OAuth token exchange failed unexpectedly.', 'OAUTH_EXCHANGE_FAILED');
  }

  const json = (await response.json().catch(() => undefined)) as { access_token?: string; error?: string } | undefined;
  if (!response.ok || !json?.access_token) {
    throw new GitHubOAuthError('GitHub OAuth token exchange was rejected.', 'OAUTH_EXCHANGE_FAILED');
  }
  return json.access_token;
}

async function fetchGitHubProfile(accessToken: string, signal: AbortSignal): Promise<GitHubProfile> {
  const userResponse = await githubGet('/user', accessToken, signal);
  const user = userResponse as { id: number; login: string; email: string | null; name: string | null; avatar_url: string | null };

  let email = user.email;
  if (!email) {
    // Public email is empty — fall back to the primary verified email via
    // the user:email scope granted above. Best-effort: login must still
    // succeed even if this secondary call fails or returns nothing.
    try {
      const emails = (await githubGet('/user/emails', accessToken, signal)) as Array<{ email: string; primary: boolean; verified: boolean }>;
      email = emails.find((e) => e.primary && e.verified)?.email ?? null;
    } catch {
      email = null;
    }
  }

  return { id: user.id, login: user.login, email, name: user.name, avatarUrl: user.avatar_url };
}

async function githubGet(path: string, accessToken: string, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API_BASE}${path}`, {
      method: 'GET',
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
      },
    });
  } catch {
    throw new GitHubOAuthError('GitHub profile request failed unexpectedly.', 'OAUTH_EXCHANGE_FAILED');
  }

  if (!response.ok) {
    throw new GitHubOAuthError(`GitHub profile request failed (${response.status}).`, 'OAUTH_EXCHANGE_FAILED');
  }
  return response.json();
}
