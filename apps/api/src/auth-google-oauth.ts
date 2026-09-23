/**
 * Google OAuth (Authorization Code flow, OIDC) for Origami Lens's own login —
 * a second login provider alongside auth-github-oauth.ts, added specifically
 * so a Founder/Agency/Designer/QA/PM user who has no GitHub, GitLab, or
 * Bitbucket account can still sign in. Structurally identical to
 * auth-github-oauth.ts on purpose (same shape of config/error/profile
 * functions) — this module never touches a repository, branch, commit, or
 * PR, and never mints or stores a long-lived credential: the access token is
 * used in-memory for the immediately-following userinfo fetch and then
 * discarded (see completeGoogleOAuthLogin).
 *
 * Read fresh from process.env on every call, matching this project's
 * pool.ts/GITHUB_OAUTH_* convention, so tests can toggle configuration via
 * process.env without re-importing.
 */

const GOOGLE_USERINFO_URL = process.env.GOOGLE_USERINFO_URL ?? 'https://openidconnect.googleapis.com/v1/userinfo';
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

export class GoogleOAuthError extends Error {
  constructor(message: string, public readonly code: 'AUTH_NOT_CONFIGURED' | 'OAUTH_EXCHANGE_FAILED') {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export function getGoogleOAuthConfig(): GoogleOAuthConfig | undefined {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const callbackUrl = process.env.GOOGLE_OAUTH_CALLBACK_URL?.trim();
  if (!clientId || !clientSecret || !callbackUrl) return undefined;
  return { clientId, clientSecret, callbackUrl };
}

export function isGoogleOAuthConfigured(): boolean {
  return getGoogleOAuthConfig() !== undefined;
}

/** `state` is generated and verified entirely by the caller (index.ts, same double-submit cookie pattern as GitHub login) — this function just forwards it. */
export function buildGoogleAuthorizeUrl(state: string): string {
  const config = getGoogleOAuthConfig();
  if (!config) throw new GoogleOAuthError('Google OAuth login is not configured.', 'AUTH_NOT_CONFIGURED');

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.callbackUrl);
  url.searchParams.set('response_type', 'code');
  // openid+profile+email is the standard OIDC scope set for "who is this
  // person" — no Drive/Gmail/Calendar/any other Google API scope of any
  // kind. This token is only ever used for the userinfo lookup below and is
  // discarded immediately after (see completeGoogleOAuthLogin).
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  return url.toString();
}

export interface GoogleProfile {
  /** OIDC "sub" — Google's stable, immutable per-account identifier. NEVER the email: a user can change their email, and Google Workspace can even reassign an email address, but `sub` never changes and is never reused. */
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

/** Never logs, returns, or otherwise persists the access token — it is used in-memory for the immediately-following userinfo fetch and then discarded. */
export async function completeGoogleOAuthLogin(code: string, signal?: AbortSignal): Promise<GoogleProfile> {
  const config = getGoogleOAuthConfig();
  if (!config) throw new GoogleOAuthError('Google OAuth login is not configured.', 'AUTH_NOT_CONFIGURED');

  const timeoutSignal = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const accessToken = await exchangeCodeForAccessToken(config, code, combinedSignal);
  return fetchGoogleProfile(accessToken, combinedSignal);
}

async function exchangeCodeForAccessToken(config: GoogleOAuthConfig, code: string, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.callbackUrl,
        grant_type: 'authorization_code',
      }).toString(),
    });
  } catch {
    throw new GoogleOAuthError('Google OAuth token exchange failed unexpectedly.', 'OAUTH_EXCHANGE_FAILED');
  }

  const json = (await response.json().catch(() => undefined)) as { access_token?: string; error?: string } | undefined;
  if (!response.ok || !json?.access_token) {
    throw new GoogleOAuthError('Google OAuth token exchange was rejected.', 'OAUTH_EXCHANGE_FAILED');
  }
  return json.access_token;
}

async function fetchGoogleProfile(accessToken: string, signal: AbortSignal): Promise<GoogleProfile> {
  let response: Response;
  try {
    response = await fetch(GOOGLE_USERINFO_URL, {
      method: 'GET',
      signal,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
  } catch {
    throw new GoogleOAuthError('Google profile request failed unexpectedly.', 'OAUTH_EXCHANGE_FAILED');
  }

  if (!response.ok) {
    throw new GoogleOAuthError(`Google profile request failed (${response.status}).`, 'OAUTH_EXCHANGE_FAILED');
  }

  const user = (await response.json()) as { sub: string; email?: string | null; name?: string | null; picture?: string | null };
  if (!user.sub) {
    throw new GoogleOAuthError('Google did not return a stable account identifier.', 'OAUTH_EXCHANGE_FAILED');
  }
  return { id: user.sub, email: user.email ?? null, name: user.name ?? null, avatarUrl: user.picture ?? null };
}
