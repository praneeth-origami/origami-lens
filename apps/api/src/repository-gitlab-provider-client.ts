import type {
  CreatePullRequestParams,
  PullRequestInfo,
  PushCredentials,
  RepositoryInfo,
  RepositoryProviderClient,
} from './repository-provider-client.js';
import { RepositoryProviderError } from './repository-provider-client.js';
import { isGitLabOAuthConfigured } from './gitlab-oauth.js';
import { resolveGitLabAccessToken } from './provider-connection-service.js';
import { ProviderConnectionRepository } from './db/provider-connection-repository.js';

/**
 * GitLab.com's own REST API base — deliberately NOT accepted from any
 * client-supplied value (see the Phase 13 report's URL-safety section):
 * this constant is only ever overridable via trusted server-side
 * configuration (GITLAB_API_BASE_URL, e.g. for a self-managed GitLab
 * instance or a mock server in tests), never from a request body/query.
 */
const GITLAB_API_BASE = process.env.GITLAB_API_BASE_URL ?? 'https://gitlab.com/api/v4';
const USER_AGENT = 'origami-lens-repository-fix-workflow';

function envInt(name: string, defaultValue: number, minValue = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minValue) return defaultValue;
  return parsed;
}

/** Legacy/testing fallback only (see resolveToken below) — a single server-side personal/project access token, never the production per-user mechanism once GitLab OAuth is configured. */
function getGitLabToken(): string | undefined {
  const token = process.env.GITLAB_TOKEN;
  return token && token.trim() ? token.trim() : undefined;
}

export function isGitLabConfigured(): boolean {
  return isGitLabOAuthConfigured() || Boolean(getGitLabToken());
}

const GITLAB_REQUEST_TIMEOUT_MS = envInt('GITLAB_API_TIMEOUT_MS', 15_000);
const connectionRepo = new ProviderConnectionRepository();

/**
 * Phase 16/D: resolves the REAL credential for THIS user, once per call —
 * their own GitLab OAuth access token (refreshed transparently if expired)
 * when OAuth is configured; the single server-side GITLAB_TOKEN ONLY when
 * OAuth is not configured at all (a documented, pre-production fallback —
 * see the Phase 16 design report and the identical GITHUB_TOKEN pattern in
 * repository-github-provider-client.ts). Once OAuth IS configured, the
 * global token is never consulted again, for any user.
 */
async function resolveToken(userId: string, signal?: AbortSignal): Promise<{ token: string; isOAuth: boolean }> {
  if (isGitLabOAuthConfigured()) {
    const token = await resolveGitLabAccessToken(userId, { connectionRepo }, signal);
    return { token, isOAuth: true };
  }
  const token = getGitLabToken();
  if (!token) throw new RepositoryProviderError('GitLab authentication is not configured (neither GitLab OAuth nor GITLAB_TOKEN is set up).', 'AUTH_NOT_CONFIGURED');
  return { token, isOAuth: false };
}

/** GitLab's own status-code semantics, not GitHub's: 403 here specifically means "forbidden" (insufficient permission), and 429 (not 403) is GitLab's rate-limit response — each provider classifies its OWN real error shape rather than being forced into an identical mapping. */
function classifyStatus(status: number): RepositoryProviderError['category'] {
  if (status === 401) return 'AUTH_FAILED';
  if (status === 403) return 'AUTH_FAILED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  return 'REQUEST_FAILED';
}

/** Never includes the raw response body verbatim, and NEVER the token value (only ever sent as a header, never interpolated into a message). */
function safeErrorMessage(status: number, statusText: string): string {
  return `GitLab API request failed (${status} ${statusText}).`;
}

/** `owner/repo` -> GitLab's URL-encoded "project path" identifier, the standard way to address a project without first resolving a numeric id. */
function projectPath(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

async function gitlabRequest(path: string, userId: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; json: unknown }> {
  const { token, isOAuth } = await resolveToken(userId, signal);

  const timeoutSignal = AbortSignal.timeout(GITLAB_REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  // GitLab's two token kinds use different headers: an OAuth2 access token
  // is only ever sent as a Bearer credential (RFC 6749); PRIVATE-TOKEN is
  // specifically GitLab's own convention for personal/project access
  // tokens (the GITLAB_TOKEN fallback) — sending the wrong header for
  // either kind is simply rejected by GitLab, so this distinction is
  // load-bearing, not cosmetic.
  const authHeader: Record<string, string> = isOAuth ? { Authorization: `Bearer ${token}` } : { 'PRIVATE-TOKEN': token };

  let response: Response;
  try {
    response = await fetch(`${GITLAB_API_BASE}${path}`, {
      ...init,
      signal: combinedSignal,
      headers: {
        ...authHeader,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError' || (error as { name?: string }).name === 'TimeoutError') {
      throw new RepositoryProviderError('GitLab API request timed out.', 'REQUEST_FAILED');
    }
    throw new RepositoryProviderError('GitLab API request failed unexpectedly.', 'REQUEST_FAILED');
  }

  const json = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new RepositoryProviderError(safeErrorMessage(response.status, response.statusText), classifyStatus(response.status));
  }
  return { status: response.status, json };
}

/**
 * GitLab implementation of RepositoryProviderClient. Every request goes
 * through gitlabRequest() above — the token is resolved fresh, per user,
 * on every call (never persisted in this class, never logged), and every
 * thrown error is a RepositoryProviderError carrying only a generic,
 * credential-free message. Mirrors repository-github-provider-client.ts's
 * structure, adapted to GitLab's own API shapes (project path instead of
 * owner/repo path segments, merge_requests instead of pulls, iid instead
 * of number).
 */
export class GitLabProviderClient implements RepositoryProviderClient {
  readonly provider = 'GITLAB' as const;

  /** GitLab's documented convention for authenticating `git push` over HTTPS with an OAuth2 access token or a personal/project access token: any username is accepted as long as the password is the token, and `oauth2` is GitLab's own recommended literal for this (parallel to GitHub's `x-access-token`) — used for both token kinds, since GitLab's Git-over-HTTP transport (unlike its REST API) doesn't distinguish them. */
  async getPushCredentials(userId: string, _owner: string, _repo: string, signal?: AbortSignal): Promise<PushCredentials> {
    const { token } = await resolveToken(userId, signal);
    return { username: 'oauth2', token };
  }

  async validateRemoteAccess(userId: string, owner: string, repo: string, signal?: AbortSignal): Promise<void> {
    await gitlabRequest(`/projects/${projectPath(owner, repo)}`, userId, { method: 'GET' }, signal);
  }

  async getRepositoryInfo(userId: string, owner: string, repo: string, signal?: AbortSignal): Promise<RepositoryInfo> {
    const { json } = await gitlabRequest(`/projects/${projectPath(owner, repo)}`, userId, { method: 'GET' }, signal);
    const defaultBranch = (json as { default_branch?: string })?.default_branch;
    if (!defaultBranch) {
      throw new RepositoryProviderError('GitLab did not report a default branch for this project.', 'REQUEST_FAILED');
    }
    return { defaultBranch };
  }

  async createPullRequest(userId: string, params: CreatePullRequestParams, signal?: AbortSignal): Promise<PullRequestInfo> {
    try {
      const { json } = await gitlabRequest(
        `/projects/${projectPath(params.owner, params.repo)}/merge_requests`,
        userId,
        { method: 'POST', body: JSON.stringify({ source_branch: params.head, target_branch: params.base, title: params.title, description: params.body }) },
        signal,
      );
      const mr = json as { iid: number; web_url: string };
      return { number: mr.iid, url: mr.web_url, alreadyExisted: false };
    } catch (error) {
      // GitLab returns 409 when an open MR for this source branch already
      // exists — the idempotency case: look it up and return it instead of
      // failing (same pattern as GitHub's 422 handling).
      if (error instanceof RepositoryProviderError && error.category === 'REQUEST_FAILED') {
        const existing = await this.findExistingMergeRequest(userId, params, signal);
        if (existing) return existing;
      }
      throw error;
    }
  }

  private async findExistingMergeRequest(userId: string, params: CreatePullRequestParams, signal?: AbortSignal): Promise<PullRequestInfo | undefined> {
    try {
      const { json } = await gitlabRequest(
        `/projects/${projectPath(params.owner, params.repo)}/merge_requests?source_branch=${encodeURIComponent(params.head)}&state=opened`,
        userId,
        { method: 'GET' },
        signal,
      );
      const mrs = json as Array<{ iid: number; web_url: string }>;
      const match = mrs?.[0];
      return match ? { number: match.iid, url: match.web_url, alreadyExisted: true } : undefined;
    } catch {
      return undefined;
    }
  }
}
