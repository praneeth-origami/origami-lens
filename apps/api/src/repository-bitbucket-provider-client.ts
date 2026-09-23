import type {
  CreatePullRequestParams,
  PullRequestInfo,
  PushCredentials,
  RepositoryInfo,
  RepositoryProviderClient,
} from './repository-provider-client.js';
import { RepositoryProviderError } from './repository-provider-client.js';
import { isBitbucketOAuthConfigured } from './bitbucket-oauth.js';
import { resolveBitbucketAccessToken } from './provider-connection-service.js';
import { ProviderConnectionRepository } from './db/provider-connection-repository.js';

/** Bitbucket Cloud's REST API base — same "trusted config only, never client-supplied" rule as GITHUB_API_BASE_URL/GITLAB_API_BASE_URL. */
const BITBUCKET_API_BASE = process.env.BITBUCKET_API_BASE_URL ?? 'https://api.bitbucket.org/2.0';
const USER_AGENT = 'origami-lens-repository-fix-workflow';

function envInt(name: string, defaultValue: number, minValue = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minValue) return defaultValue;
  return parsed;
}

/** Legacy/testing fallback only (see resolveCredential below) — a single server-side App Password, never the production per-user mechanism once Bitbucket OAuth is configured. Bitbucket's App Password auth requires the REAL account username paired with the app password — unlike GitHub/GitLab, there is no "any username works" convention for THIS credential kind. */
function getBitbucketAppPassword(): { username: string; token: string } | undefined {
  const username = process.env.BITBUCKET_USERNAME?.trim();
  const token = process.env.BITBUCKET_TOKEN?.trim();
  if (!username || !token) return undefined;
  return { username, token };
}

export function isBitbucketConfigured(): boolean {
  return isBitbucketOAuthConfigured() || Boolean(getBitbucketAppPassword());
}

const BITBUCKET_REQUEST_TIMEOUT_MS = envInt('BITBUCKET_API_TIMEOUT_MS', 15_000);
const connectionRepo = new ProviderConnectionRepository();

interface ResolvedBitbucketCredential {
  /** REST API auth: Bearer for an OAuth access token, Basic (username:app-password) for the legacy fallback. */
  authHeader: string;
  /** git push auth: Bitbucket's documented `x-token-auth` literal for OAuth tokens, or the real account username for the App Password fallback. */
  pushUsername: string;
  pushToken: string;
}

/**
 * Phase 16/E: resolves the REAL credential for THIS user, once per call —
 * their own Bitbucket OAuth access token (refreshed transparently if
 * expired) when OAuth is configured; the single server-side
 * BITBUCKET_USERNAME/BITBUCKET_TOKEN App Password ONLY when OAuth is not
 * configured at all (a documented, pre-production fallback — identical
 * pattern to GITHUB_TOKEN/GITLAB_TOKEN). Once OAuth IS configured, the
 * global App Password is never consulted again, for any user.
 */
async function resolveCredential(userId: string, signal?: AbortSignal): Promise<ResolvedBitbucketCredential> {
  if (isBitbucketOAuthConfigured()) {
    const token = await resolveBitbucketAccessToken(userId, { connectionRepo }, signal);
    return { authHeader: `Bearer ${token}`, pushUsername: 'x-token-auth', pushToken: token };
  }
  const appPassword = getBitbucketAppPassword();
  if (!appPassword) {
    throw new RepositoryProviderError('Bitbucket authentication is not configured (neither Bitbucket OAuth nor BITBUCKET_USERNAME/BITBUCKET_TOKEN is set up).', 'AUTH_NOT_CONFIGURED');
  }
  const basicAuth = Buffer.from(`${appPassword.username}:${appPassword.token}`).toString('base64');
  return { authHeader: `Basic ${basicAuth}`, pushUsername: appPassword.username, pushToken: appPassword.token };
}

/** Bitbucket's own status-code semantics: 403 covers both "forbidden" and (per Bitbucket's docs) most rate-limit responses, but Bitbucket also uses a dedicated 429 for the newer rate-limit tiers — both are classified as RATE_LIMITED here to avoid mis-reporting a real quota exhaustion as a generic auth failure. */
function classifyStatus(status: number): RepositoryProviderError['category'] {
  if (status === 401) return 'AUTH_FAILED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 403 || status === 429) return 'RATE_LIMITED';
  return 'REQUEST_FAILED';
}

function safeErrorMessage(status: number, statusText: string): string {
  return `Bitbucket API request failed (${status} ${statusText}).`;
}

async function bitbucketRequest(path: string, userId: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; json: unknown }> {
  const { authHeader } = await resolveCredential(userId, signal);

  const timeoutSignal = AbortSignal.timeout(BITBUCKET_REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(`${BITBUCKET_API_BASE}${path}`, {
      ...init,
      signal: combinedSignal,
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError' || (error as { name?: string }).name === 'TimeoutError') {
      throw new RepositoryProviderError('Bitbucket API request timed out.', 'REQUEST_FAILED');
    }
    throw new RepositoryProviderError('Bitbucket API request failed unexpectedly.', 'REQUEST_FAILED');
  }

  const json = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new RepositoryProviderError(safeErrorMessage(response.status, response.statusText), classifyStatus(response.status));
  }
  return { status: response.status, json };
}

/**
 * Bitbucket implementation of RepositoryProviderClient. `owner` here is
 * Bitbucket's "workspace" and `repo` its "repo_slug" — the same two
 * strings parseRepositoryUrl() already extracts from
 * https://bitbucket.org/<workspace>/<repo_slug>, so no new URL parsing is
 * introduced. Every request goes through bitbucketRequest() above — the
 * credential is resolved per-user, per call (never persisted in this
 * class, never logged); every thrown error is a RepositoryProviderError
 * with a generic, credential-free message.
 */
export class BitbucketProviderClient implements RepositoryProviderClient {
  readonly provider = 'BITBUCKET' as const;

  /** `x-token-auth` is Bitbucket's own documented convention for OAuth-token-based git operations (parallel to GitHub's `x-access-token`/GitLab's `oauth2`) — distinct from the App Password fallback, which requires the real account username since Bitbucket has no "any username" convention for that credential kind. */
  async getPushCredentials(userId: string, _owner: string, _repo: string, signal?: AbortSignal): Promise<PushCredentials> {
    const { pushUsername, pushToken } = await resolveCredential(userId, signal);
    return { username: pushUsername, token: pushToken };
  }

  async validateRemoteAccess(userId: string, owner: string, repo: string, signal?: AbortSignal): Promise<void> {
    await bitbucketRequest(`/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, userId, { method: 'GET' }, signal);
  }

  async getRepositoryInfo(userId: string, owner: string, repo: string, signal?: AbortSignal): Promise<RepositoryInfo> {
    const { json } = await bitbucketRequest(`/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, userId, { method: 'GET' }, signal);
    const defaultBranch = (json as { mainbranch?: { name?: string } })?.mainbranch?.name;
    if (!defaultBranch) {
      throw new RepositoryProviderError('Bitbucket did not report a default branch for this repository.', 'REQUEST_FAILED');
    }
    return { defaultBranch };
  }

  /**
   * Bitbucket's duplicate-pull-request error response is not as
   * consistently documented/shaped as GitHub's 422 or GitLab's 409, so
   * idempotency here uses check-then-act instead of create-then-recover:
   * look for an existing OPEN pull request for this head branch FIRST, and
   * only call the create endpoint if none exists. Equally correct, just a
   * different (arguably more robust, for this specific provider) route to
   * the same guarantee the workflow service requires.
   */
  async createPullRequest(userId: string, params: CreatePullRequestParams, signal?: AbortSignal): Promise<PullRequestInfo> {
    const existing = await this.findExistingPullRequest(userId, params, signal);
    if (existing) return existing;

    const { json } = await bitbucketRequest(
      `/repositories/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pullrequests`,
      userId,
      {
        method: 'POST',
        body: JSON.stringify({
          title: params.title,
          description: params.body,
          source: { branch: { name: params.head } },
          destination: { branch: { name: params.base } },
        }),
      },
      signal,
    );
    const pr = json as { id: number; links?: { html?: { href?: string } } };
    return { number: pr.id, url: pr.links?.html?.href ?? '', alreadyExisted: false };
  }

  private async findExistingPullRequest(userId: string, params: CreatePullRequestParams, signal?: AbortSignal): Promise<PullRequestInfo | undefined> {
    try {
      const query = encodeURIComponent(`source.branch.name="${params.head}" AND state="OPEN"`);
      const { json } = await bitbucketRequest(
        `/repositories/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pullrequests?q=${query}`,
        userId,
        { method: 'GET' },
        signal,
      );
      const values = (json as { values?: Array<{ id: number; links?: { html?: { href?: string } } }> })?.values;
      const match = values?.[0];
      return match ? { number: match.id, url: match.links?.html?.href ?? '', alreadyExisted: true } : undefined;
    } catch {
      return undefined;
    }
  }
}
