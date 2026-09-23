/**
 * GitHub App server-to-server authentication (Phase 16/C) — how Origami
 * Lens obtains a real, short-lived, repository-scoped push/API token for a
 * SPECIFIC user's SPECIFIC repository, replacing the single global
 * GITHUB_TOKEN model. Distinct from auth-github-oauth.ts (which is only
 * about "who is this human" login) and repository-github-provider-client.ts
 * (the generic REST client, which this module supplies credentials to).
 *
 * Nothing here ever persists a token: an installation access token is
 * minted fresh from the App's private key on every call and discarded
 * immediately after use (GitHub's own tokens already expire in ~1 hour).
 *
 * A small, hand-rolled RS256 JWT signer is used instead of adding a JWT
 * library — this process only ever CREATES a fixed-shape token to send to
 * GitHub, never parses/verifies an incoming one, so the usual reasons to
 * prefer a full JWT library (algorithm confusion, claim validation, header
 * injection) don't apply; the shape is entirely ours.
 */
import { createSign } from 'node:crypto';

const GITHUB_API_BASE = process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com';
const USER_AGENT = 'origami-lens-github-app';
const REQUEST_TIMEOUT_MS = 15_000;

export class GitHubAppError extends Error {
  constructor(message: string, public readonly code: 'APP_NOT_CONFIGURED' | 'INSTALLATION_NOT_FOUND' | 'REQUEST_FAILED') {
    super(message);
    this.name = 'GitHubAppError';
  }
}

interface GitHubAppConfig {
  appId: string;
  privateKey: string;
}

/** `.env` cannot hold a real multi-line PEM value directly — GITHUB_APP_PRIVATE_KEY is stored with literal `\n` sequences and unescaped here, the same convention widely used for PEM keys in env-var-based configuration. */
function getGitHubAppConfig(): GitHubAppConfig | undefined {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !rawKey) return undefined;
  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  return { appId, privateKey };
}

export function isGitHubAppConfigured(): boolean {
  return getGitHubAppConfig() !== undefined;
}

export function getGitHubAppSlug(): string | undefined {
  const slug = process.env.GITHUB_APP_SLUG?.trim();
  return slug || undefined;
}

/** Full-page navigation target for "Connect GitHub" — installs the App on whichever repositories the user selects, then GitHub redirects to the App's configured Setup URL (this app's /providers/github/callback). */
export function buildGitHubAppInstallUrl(state: string): string {
  const slug = getGitHubAppSlug();
  if (!slug) throw new GitHubAppError('GitHub App is not configured (GITHUB_APP_SLUG missing).', 'APP_NOT_CONFIGURED');
  const url = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
  url.searchParams.set('state', state);
  return url.toString();
}

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input)).toString('base64url');
}

/** A short-lived (9 minute, under GitHub's 10-minute max) App-level JWT — proves "this request comes from the App itself," used only for the two App-level endpoints below (never sent to any client, never logged). */
function buildAppJwt(config: GitHubAppConfig): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: config.appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(config.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

async function githubAppRequest(path: string, config: GitHubAppConfig, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; json: unknown }> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(`${GITHUB_API_BASE}${path}`, {
      ...init,
      signal: combinedSignal,
      headers: {
        Authorization: `Bearer ${buildAppJwt(config)}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        ...init.headers,
      },
    });
  } catch {
    throw new GitHubAppError('GitHub App API request failed unexpectedly.', 'REQUEST_FAILED');
  }

  const json = await response.json().catch(() => undefined);
  return { status: response.status, json };
}

/**
 * Resolves which GitHub App installation (if any) covers this exact
 * repository — GitHub Apps are installed on a per-account, per-repository
 * basis, so this is the real authority on "has this repo been granted to
 * the App," not something Origami Lens tracks itself.
 */
export async function findInstallationForRepo(owner: string, repo: string, signal?: AbortSignal): Promise<number> {
  const config = getGitHubAppConfig();
  if (!config) throw new GitHubAppError('GitHub App is not configured.', 'APP_NOT_CONFIGURED');

  const { status, json } = await githubAppRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, config, { method: 'GET' }, signal);
  if (status === 404) {
    throw new GitHubAppError('The GitHub App is not installed on this repository.', 'INSTALLATION_NOT_FOUND');
  }
  if (status < 200 || status >= 300) {
    throw new GitHubAppError('GitHub App installation lookup failed.', 'REQUEST_FAILED');
  }
  const installationId = (json as { id?: number })?.id;
  if (!installationId) throw new GitHubAppError('GitHub did not report an installation id.', 'REQUEST_FAILED');
  return installationId;
}

export interface InstallationAccessToken {
  token: string;
  expiresAt: string;
}

/** Mints a real, short-lived (~1 hour) installation access token — never persisted, never logged, discarded by the caller immediately after use. */
export async function mintInstallationAccessToken(installationId: number, signal?: AbortSignal): Promise<InstallationAccessToken> {
  const config = getGitHubAppConfig();
  if (!config) throw new GitHubAppError('GitHub App is not configured.', 'APP_NOT_CONFIGURED');

  const { status, json } = await githubAppRequest(`/app/installations/${installationId}/access_tokens`, config, { method: 'POST' }, signal);
  if (status < 200 || status >= 300) {
    throw new GitHubAppError('Failed to mint a GitHub App installation access token.', 'REQUEST_FAILED');
  }
  const body = json as { token?: string; expires_at?: string };
  if (!body?.token || !body.expires_at) throw new GitHubAppError('GitHub did not return an installation access token.', 'REQUEST_FAILED');
  return { token: body.token, expiresAt: body.expires_at };
}

export interface InstallationInfo {
  id: number;
  accountLogin: string;
}

/** Used only right after the install callback, to record which real GitHub account (org or user) this installation belongs to — display-only metadata, never an authorization key. */
export async function getInstallation(installationId: number, signal?: AbortSignal): Promise<InstallationInfo> {
  const config = getGitHubAppConfig();
  if (!config) throw new GitHubAppError('GitHub App is not configured.', 'APP_NOT_CONFIGURED');

  const { status, json } = await githubAppRequest(`/app/installations/${installationId}`, config, { method: 'GET' }, signal);
  if (status < 200 || status >= 300) {
    throw new GitHubAppError('Failed to look up the GitHub App installation.', 'REQUEST_FAILED');
  }
  const body = json as { id: number; account?: { login?: string } };
  return { id: body.id, accountLogin: body.account?.login ?? 'unknown' };
}

/**
 * Fully removes the App installation from GitHub itself
 * (`DELETE /app/installations/{id}`) — used by the `/providers/connections/:id`
 * disconnect route so "Disconnect" in Origami Lens actually disconnects the
 * GitHub App too, not just Origami Lens's own local connection record (see
 * provider-connection-repository.ts's revokeForUser, which only ever updates
 * our own DB row). A 404 (already uninstalled — e.g. manually from GitHub's
 * own settings page) is treated as success, not an error: the end state
 * ("not installed") is what the caller wants either way.
 */
export async function uninstallGitHubApp(installationId: number, signal?: AbortSignal): Promise<void> {
  const config = getGitHubAppConfig();
  if (!config) throw new GitHubAppError('GitHub App is not configured.', 'APP_NOT_CONFIGURED');

  const { status } = await githubAppRequest(`/app/installations/${installationId}`, config, { method: 'DELETE' }, signal);
  if (status === 404) return;
  if (status < 200 || status >= 300) {
    throw new GitHubAppError('Failed to uninstall the GitHub App installation.', 'REQUEST_FAILED');
  }
}
