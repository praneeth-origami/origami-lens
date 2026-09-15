import type {
  CreatePullRequestParams,
  PullRequestInfo,
  PushCredentials,
  RepositoryInfo,
  RepositoryProviderClient,
} from './repository-provider-client.js';
import { RepositoryProviderError } from './repository-provider-client.js';
import { isGitHubAppConfigured } from './github-app-auth.js';
import { resolveGitHubPushCredentials } from './provider-connection-service.js';
import { ProviderConnectionRepository } from './db/provider-connection-repository.js';

const GITHUB_API_BASE = process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com';
const USER_AGENT = 'origami-lens-repository-fix-workflow';

function envInt(name: string, defaultValue: number, minValue = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minValue) return defaultValue;
  return parsed;
}

/** Server-side only — never persisted per-repository (see the Phase 12 report's authentication-design section). Read fresh on every call, matching this project's `pool.ts`/DATABASE_URL convention, so tests can toggle it via process.env without re-importing. */
function getGitHubToken(): string | undefined {
  const token = process.env.GITHUB_TOKEN;
  return token && token.trim() ? token.trim() : undefined;
}

export function isGitHubConfigured(): boolean {
  return Boolean(getGitHubToken());
}

const GITHUB_REQUEST_TIMEOUT_MS = envInt('GITHUB_API_TIMEOUT_MS', 15_000);

function classifyStatus(status: number): RepositoryProviderError['category'] {
  if (status === 401) return 'AUTH_FAILED';
  if (status === 403) return 'RATE_LIMITED';
  if (status === 404) return 'NOT_FOUND';
  return 'REQUEST_FAILED';
}

/** Never includes the raw response body verbatim (it could theoretically echo back request content) — only a bounded, generic summary, and NEVER the Authorization header/token (never sent to fetch as anything but a header, never interpolated into a message). */
function safeErrorMessage(status: number, statusText: string): string {
  return `GitHub API request failed (${status} ${statusText}).`;
}

const connectionRepo = new ProviderConnectionRepository();

/**
 * Phase 16/D (closing a gap found auditing Phase C): resolves the SAME
 * per-user installation token getPushCredentials already used, reused here
 * for the REST API too — a GitHub App installation token is a valid Bearer
 * credential for both. GITHUB_TOKEN remains the fallback ONLY when no
 * GitHub App is configured at all, identical to getPushCredentials' own
 * fallback rule.
 */
async function resolveGitHubToken(userId: string, owner: string, repo: string, signal?: AbortSignal): Promise<string> {
  if (isGitHubAppConfigured()) {
    const { token } = await resolveGitHubPushCredentials(userId, owner, repo, { connectionRepo }, signal);
    return token;
  }
  const token = getGitHubToken();
  if (!token) throw new RepositoryProviderError('GitHub authentication is not configured (neither a GitHub App nor GITHUB_TOKEN is set up).', 'AUTH_NOT_CONFIGURED');
  return token;
}

async function githubRequest(path: string, userId: string, owner: string, repo: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; json: unknown }> {
  const token = await resolveGitHubToken(userId, owner, repo, signal);

  const timeoutSignal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(`${GITHUB_API_BASE}${path}`, {
      ...init,
      signal: combinedSignal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError' || (error as { name?: string }).name === 'TimeoutError') {
      throw new RepositoryProviderError('GitHub API request timed out.', 'REQUEST_FAILED');
    }
    throw new RepositoryProviderError('GitHub API request failed unexpectedly.', 'REQUEST_FAILED');
  }

  const json = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new RepositoryProviderError(safeErrorMessage(response.status, response.statusText), classifyStatus(response.status));
  }
  return { status: response.status, json };
}

/**
 * GitHub implementation of RepositoryProviderClient. Every request goes
 * through githubRequest() above — the credential is resolved per-user, per
 * call (never persisted in this class, never logged), and every thrown
 * error is a RepositoryProviderError carrying only a generic,
 * credential-free message.
 */
export class GitHubProviderClient implements RepositoryProviderClient {
  readonly provider = 'GITHUB' as const;

  /**
   * Phase 16/C: once a GitHub App is configured, per-user, repository-
   * scoped installation tokens are the ONLY credential path — the global
   * GITHUB_TOKEN is never consulted again, for any user, once the real
   * mechanism exists. GITHUB_TOKEN remains as an explicit, documented
   * fallback ONLY for a deployment that hasn't configured a GitHub App
   * yet (see .env.example) — this is a transitional affordance, not the
   * final architecture; `x-access-token` is GitHub's own documented
   * convention for token-based HTTPS git operations in both paths.
   */
  async getPushCredentials(userId: string, owner: string, repo: string, signal?: AbortSignal): Promise<PushCredentials> {
    if (isGitHubAppConfigured()) {
      return resolveGitHubPushCredentials(userId, owner, repo, { connectionRepo }, signal);
    }

    const token = getGitHubToken();
    if (!token) throw new RepositoryProviderError('GitHub authentication is not configured (neither a GitHub App nor GITHUB_TOKEN is set up).', 'AUTH_NOT_CONFIGURED');
    return { username: 'x-access-token', token };
  }

  async validateRemoteAccess(userId: string, owner: string, repo: string, signal?: AbortSignal): Promise<void> {
    await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, userId, owner, repo, { method: 'GET' }, signal);
  }

  async getRepositoryInfo(userId: string, owner: string, repo: string, signal?: AbortSignal): Promise<RepositoryInfo> {
    const { json } = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, userId, owner, repo, { method: 'GET' }, signal);
    const defaultBranch = (json as { default_branch?: string })?.default_branch;
    if (!defaultBranch) {
      throw new RepositoryProviderError('GitHub did not report a default branch for this repository.', 'REQUEST_FAILED');
    }
    return { defaultBranch };
  }

  async createPullRequest(userId: string, params: CreatePullRequestParams, signal?: AbortSignal): Promise<PullRequestInfo> {
    try {
      const { json } = await githubRequest(
        `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls`,
        userId, params.owner, params.repo,
        { method: 'POST', body: JSON.stringify({ title: params.title, body: params.body, head: params.head, base: params.base }) },
        signal,
      );
      const pr = json as { number: number; html_url: string };
      return { number: pr.number, url: pr.html_url, alreadyExisted: false };
    } catch (error) {
      // GitHub returns 422 when a PR for this head branch already exists —
      // the idempotency case: look it up and return it instead of failing.
      if (error instanceof RepositoryProviderError && error.category === 'REQUEST_FAILED') {
        const existing = await this.findExistingPullRequest(userId, params, signal);
        if (existing) return existing;
      }
      throw error;
    }
  }

  private async findExistingPullRequest(userId: string, params: CreatePullRequestParams, signal?: AbortSignal): Promise<PullRequestInfo | undefined> {
    try {
      const { json } = await githubRequest(
        `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls?head=${encodeURIComponent(`${params.owner}:${params.head}`)}&state=all`,
        userId, params.owner, params.repo,
        { method: 'GET' },
        signal,
      );
      const pulls = json as Array<{ number: number; html_url: string }>;
      const match = pulls?.[0];
      return match ? { number: match.number, url: match.html_url, alreadyExisted: true } : undefined;
    } catch {
      return undefined;
    }
  }
}
