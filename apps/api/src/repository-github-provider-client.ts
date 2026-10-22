import type {
  CreateGitHubIssueParams,
  CreatePullRequestParams,
  GitHubIssueInfo,
  PrStrategyResult,
  PullRequestInfo,
  PushCredentials,
  RepositoryInfo,
  RepositoryProviderClient,
} from './repository-provider-client.js';
import { RepositoryProviderError } from './repository-provider-client.js';
import { isGitHubAppConfigured } from './github-app-auth.js';
import { resolveGitHubPushCredentials, resolveGitHubUserPushToken } from './provider-connection-service.js';
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

/** Fork creation (`POST .../forks`) is asynchronous on GitHub's side — a freshly created (or freshly re-requested) fork can 404 for a few seconds before it's actually clonable/pushable. Bounded poll: ~9s ceiling by default, never unbounded. */
const FORK_READY_MAX_ATTEMPTS = envInt('GITHUB_FORK_READY_MAX_ATTEMPTS', 6);
const FORK_READY_POLL_INTERVAL_MS = envInt('GITHUB_FORK_READY_POLL_INTERVAL_MS', 1500);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 *
 * Create GitHub Issue setup modal (Issue Detail page): when the App isn't
 * installed on this repository (or this user has no connection for its
 * installation), fall back to the user's OWN push-OAuth token — the exact
 * same remedy resolvePrStrategy's USER_DIRECT/USER_FORK strategies already
 * offer for pull requests (see githubPushConnectUrl's doc comment). Without
 * this fallback, "Connect GitHub" in that modal would authorize successfully
 * and then still fail with the same AUTH_NOT_CONFIGURED error forever, since
 * issue creation never consulted the user's push token at all before this.
 * A plain GitHub issue needs no push/fork rights, only read access + the
 * token's own "issues" scope, so no repoInfo/pushAllowed check is needed
 * here — the real POST .../issues call surfaces any genuine permission gap.
 */
async function resolveGitHubToken(userId: string, owner: string, repo: string, signal?: AbortSignal): Promise<string> {
  if (isGitHubAppConfigured()) {
    try {
      const { token } = await resolveGitHubPushCredentials(userId, owner, repo, { connectionRepo }, signal);
      return token;
    } catch (error) {
      if (!(error instanceof RepositoryProviderError) || error.category !== 'AUTH_NOT_CONFIGURED') throw error;
      const userToken = await resolveGitHubUserPushToken(userId, { connectionRepo });
      if (userToken) return userToken;
      throw error;
    }
  }
  const token = getGitHubToken();
  if (!token) throw new RepositoryProviderError('GitHub authentication is not configured (neither a GitHub App nor GITHUB_TOKEN is set up).', 'AUTH_NOT_CONFIGURED');
  return token;
}

/** `explicitToken`, when given, is used verbatim instead of resolving via the App path — the USER_DIRECT/USER_FORK strategies already hold the user's own token from resolvePrStrategy and must never re-derive an App token (which may not even be usable for this repo — that's the whole reason those strategies exist). */
async function githubRequest(path: string, userId: string, owner: string, repo: string, init: RequestInit, signal?: AbortSignal, explicitToken?: string): Promise<{ status: number; json: unknown }> {
  const token = explicitToken ?? (await resolveGitHubToken(userId, owner, repo, signal));

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

type UserPushTokenResolver = (userId: string) => Promise<string | undefined>;

export interface GitHubProviderClientDeps {
  /** Defaults to resolveGitHubUserPushToken against the real ProviderConnectionRepository — injectable purely for tests, so resolvePrStrategy's USER_DIRECT/USER_FORK/ADMIN_APPROVAL_REQUIRED branches can be exercised without a real Postgres connection. */
  resolveUserPushToken?: UserPushTokenResolver;
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
  private readonly resolveUserPushToken: UserPushTokenResolver;

  constructor(deps: GitHubProviderClientDeps = {}) {
    this.resolveUserPushToken = deps.resolveUserPushToken ?? ((userId) => resolveGitHubUserPushToken(userId, { connectionRepo }));
  }

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

  /**
   * `params.owner`/`params.repo` are always the ORIGINAL (base) repository —
   * GitHub's `POST /repos/{owner}/{repo}/pulls` is always called against the
   * base repo, whether `head` is a branch on that same repo (GITHUB_APP_DIRECT/
   * USER_DIRECT) or `headOwner:branch` on a fork (USER_FORK). `authToken`,
   * when set, is used verbatim (see githubRequest) instead of re-resolving
   * an App token that may not even cover this repo.
   */
  async createPullRequest(userId: string, params: CreatePullRequestParams, signal?: AbortSignal): Promise<PullRequestInfo> {
    const head = params.headOwner && params.headOwner !== params.owner ? `${params.headOwner}:${params.head}` : params.head;
    try {
      const { json } = await githubRequest(
        `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls`,
        userId, params.owner, params.repo,
        { method: 'POST', body: JSON.stringify({ title: params.title, body: params.body, head, base: params.base }) },
        signal,
        params.authToken,
      );
      const pr = json as { number: number; html_url: string };
      return { number: pr.number, url: pr.html_url, alreadyExisted: false };
    } catch (error) {
      // GitHub returns 422 when a PR for this head branch already exists —
      // the idempotency case: look it up and return it instead of failing.
      if (error instanceof RepositoryProviderError && error.category === 'REQUEST_FAILED') {
        const existing = await this.findExistingPullRequest(userId, params, head, signal);
        if (existing) return existing;
      }
      throw error;
    }
  }

  /**
   * Create GitHub Issue (roadmap Phase 7) — a plain issue, never a branch/
   * commit/PR (that's createPullRequest above). Reuses githubRequest's
   * existing per-user App-installation credential resolution unchanged; if
   * the installation's granted permissions don't include "Issues: write"
   * (see this contract's own doc comment), GitHub returns 403/404 here,
   * which classifyStatus already maps to AUTH_FAILED/NOT_FOUND — surfaced
   * to the caller as a clear error, never silently bypassed or retried with
   * different credentials.
   */
  async createIssue(userId: string, params: CreateGitHubIssueParams, signal?: AbortSignal): Promise<GitHubIssueInfo> {
    const { json } = await githubRequest(
      `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/issues`,
      userId, params.owner, params.repo,
      { method: 'POST', body: JSON.stringify({ title: params.title, body: params.body, labels: params.labels }) },
      signal,
    );
    const issue = json as { number: number; html_url: string };
    return { number: issue.number, url: issue.html_url };
  }

  private async findExistingPullRequest(userId: string, params: CreatePullRequestParams, head: string, signal?: AbortSignal): Promise<PullRequestInfo | undefined> {
    try {
      // `head` here must be qualified with the OWNING account of the branch
      // (`headOwner:branch` for a fork, `owner:branch` otherwise) — GitHub's
      // `head` query filter requires this regardless of which repo it's queried against.
      const qualifiedHead = head.includes(':') ? head : `${params.owner}:${head}`;
      const { json } = await githubRequest(
        `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls?head=${encodeURIComponent(qualifiedHead)}&state=all`,
        userId, params.owner, params.repo,
        { method: 'GET' },
        signal,
        params.authToken,
      );
      const pulls = json as Array<{ number: number; html_url: string }>;
      const match = pulls?.[0];
      return match ? { number: match.number, url: match.html_url, alreadyExisted: true } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolves which of GITHUB_APP_DIRECT/USER_DIRECT/USER_FORK/
   * ADMIN_APPROVAL_REQUIRED applies for this exact user + repository — see
   * PrStrategyResult's doc comment. Tries the existing, unchanged App path
   * first (step 1); only reads the user's OWN GitHub permissions (steps
   * 2-3) when the App genuinely can't reach this repo, never as a
   * shortcut around it.
   */
  async resolvePrStrategy(userId: string, owner: string, repo: string, signal?: AbortSignal, opts?: { preview?: boolean }): Promise<PrStrategyResult> {
    try {
      const pushCredentials = await this.getPushCredentials(userId, owner, repo, signal);
      return { strategy: 'GITHUB_APP_DIRECT', detail: 'The Origami Lens GitHub App is installed on this repository.', pushCredentials };
    } catch (error) {
      if (!(error instanceof RepositoryProviderError) || error.category !== 'AUTH_NOT_CONFIGURED') throw error;
    }

    const userToken = await this.resolveUserPushToken(userId);
    if (!userToken) {
      return {
        strategy: 'ADMIN_APPROVAL_REQUIRED',
        detail: 'The Origami Lens GitHub App is not installed on this repository, and you have not connected your own GitHub account for direct push access. Connect GitHub for direct access from the Repositories page, or ask an organization/repository administrator to install the Origami Lens GitHub App.',
      };
    }

    const repoInfo = await this.fetchRepoAsUser(owner, repo, userToken, signal);
    if (!repoInfo) {
      return {
        strategy: 'ADMIN_APPROVAL_REQUIRED',
        detail: 'Your connected GitHub account cannot access this repository. Ask an organization/repository administrator to grant access or install the Origami Lens GitHub App.',
      };
    }

    if (repoInfo.pushAllowed) {
      return {
        strategy: 'USER_DIRECT',
        detail: 'Using your own GitHub write access to push a branch directly to this repository.',
        pushCredentials: { username: 'x-access-token', token: userToken },
        defaultBranch: repoInfo.defaultBranch,
      };
    }

    if (repoInfo.allowForking) {
      if (opts?.preview) {
        return {
          strategy: 'USER_FORK',
          detail: 'You have read access to this repository — Origami Lens will fork it and open a pull request from your fork.',
          defaultBranch: repoInfo.defaultBranch,
        };
      }
      const fork = await this.ensureFork(owner, repo, userToken, signal);
      return {
        strategy: 'USER_FORK',
        detail: `Forked to ${fork.owner}/${repo} — the pull request will be opened from there.`,
        pushCredentials: { username: 'x-access-token', token: userToken },
        forkOwner: fork.owner,
        forkCloneUrl: fork.cloneUrl,
        defaultBranch: repoInfo.defaultBranch,
      };
    }

    return {
      strategy: 'ADMIN_APPROVAL_REQUIRED',
      detail: 'You only have read access to this repository and forking is disabled by its organization. Ask an organization/repository administrator to install the Origami Lens GitHub App or grant you write access.',
    };
  }

  /** `GET /repos/{owner}/{repo}` authenticated AS THE USER (never the App) — `permissions.push` and `allow_forking` are only meaningful from this exact user's own perspective, which is the entire point of this check. Returns undefined for any non-2xx response (no access) rather than throwing, since "the user can't reach this repo" is an expected, non-exceptional outcome here. */
  private async fetchRepoAsUser(owner: string, repo: string, userToken: string, signal?: AbortSignal): Promise<{ pushAllowed: boolean; allowForking: boolean; defaultBranch: string } | undefined> {
    const timeoutSignal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(`${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        signal: combinedSignal,
        headers: { Authorization: `Bearer ${userToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': USER_AGENT },
      });
    } catch {
      return undefined;
    }
    if (!response.ok) return undefined;
    const json = (await response.json().catch(() => undefined)) as { permissions?: { push?: boolean }; allow_forking?: boolean; default_branch?: string } | undefined;
    if (!json?.default_branch) return undefined;
    return { pushAllowed: json.permissions?.push === true, allowForking: json.allow_forking !== false, defaultBranch: json.default_branch };
  }

  /**
   * `POST /repos/{owner}/{repo}/forks` is idempotent — if the user (or their
   * org, for an org-owned fork target) already has a fork of this repo,
   * GitHub returns THAT existing fork rather than erroring, so this is safe
   * to call on every USER_FORK approval, not just the first. Fork creation
   * is asynchronous, so this then polls the fork itself until it 200s
   * (bounded — see FORK_READY_MAX_ATTEMPTS).
   */
  private async ensureFork(owner: string, repo: string, userToken: string, signal?: AbortSignal): Promise<{ owner: string; cloneUrl: string }> {
    const timeoutSignal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const headers = { Authorization: `Bearer ${userToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': USER_AGENT };

    let response: Response;
    try {
      response = await fetch(`${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/forks`, { method: 'POST', signal: combinedSignal, headers });
    } catch {
      throw new RepositoryProviderError('Failed to create a fork of this repository.', 'REQUEST_FAILED');
    }
    const json = (await response.json().catch(() => undefined)) as { owner?: { login?: string }; clone_url?: string } | undefined;
    if (!response.ok || !json?.owner?.login || !json.clone_url) {
      throw new RepositoryProviderError('GitHub did not return a usable fork for this repository.', 'REQUEST_FAILED');
    }
    const forkOwner = json.owner.login;
    const cloneUrl = json.clone_url;

    for (let attempt = 0; attempt < FORK_READY_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(FORK_READY_POLL_INTERVAL_MS);
      const check = await fetch(`${GITHUB_API_BASE}/repos/${encodeURIComponent(forkOwner)}/${encodeURIComponent(repo)}`, { signal: combinedSignal, headers }).catch(() => undefined);
      if (check?.ok) return { owner: forkOwner, cloneUrl };
    }
    throw new RepositoryProviderError('The fork was created but is not ready yet — try approving again shortly.', 'FORK_NOT_READY');
  }
}
