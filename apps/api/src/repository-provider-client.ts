import type { RepositoryFixPrProvider, RepositoryFixPrStrategy } from '@origami/contracts';

/**
 * Provider-agnostic abstraction for the one remote-hosting operation Phase
 * 12 needs beyond plain `git` (which already works identically against any
 * host): opening a Pull/Merge Request through the host's own API, plus two
 * small supporting reads. Nothing in repository-fix-workflow-service.ts
 * ever imports a GitHub-specific type or calls the GitHub API directly —
 * only this interface, so GitLab/Bitbucket can be added later as a second
 * implementation of the same three methods without touching the workflow
 * service at all.
 */
export interface CreatePullRequestParams {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  /**
   * Set only for a fork-based PR (USER_FORK strategy) — the fork's owner
   * login. When present and different from `owner`, GitHubProviderClient
   * formats `head` as `"headOwner:head"` (GitHub's real cross-repo PR
   * contract); every other provider/call site ignores this field. `owner`/
   * `repo` always stay the ORIGINAL (base) repository — GitHub's PR API is
   * always called against the base repo, never the fork.
   */
  headOwner?: string;
  /**
   * Overrides the provider client's normal credential resolution (the App
   * installation path) with an already-resolved token — used for
   * USER_DIRECT/USER_FORK, where the caller (resolvePrStrategy) already
   * holds the user's own GitHub token and re-deriving an App token would be
   * wrong (the App may not even be installed on this repo). Ignored by
   * providers that only have one credential path.
   */
  authToken?: string;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  /** True if this PR was found already open for `head` rather than newly created — the idempotency case. */
  alreadyExisted: boolean;
}

export interface RepositoryInfo {
  defaultBranch: string;
}

/** Create GitHub Issue (roadmap Phase 7) — a plain issue, never a branch/commit/PR. */
export interface CreateGitHubIssueParams {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface GitHubIssueInfo {
  number: number;
  url: string;
}

/**
 * The Basic-auth identity used ONLY for `git push` (see repository-git.ts's
 * pushBranch) — deliberately separate from the provider's REST API
 * authentication scheme (a bearer token / PRIVATE-TOKEN header), since Git's
 * own HTTPS transport always authenticates via Basic auth regardless of
 * what the host's REST API expects. Each provider knows its own convention
 * (GitHub: `x-access-token`; GitLab: `oauth2`; Bitbucket: the real account
 * username) — the workflow service never hardcodes any of this.
 */
export interface PushCredentials {
  username: string;
  token: string;
}

/**
 * The result of resolving HOW a PR will be created for a given
 * repository+user (see repository-github-provider-client.ts's
 * resolvePrStrategy) — used both for a real approval (pushCredentials
 * present, ready to use) and for a read-only UI preview (pushCredentials
 * omitted; `preview: true` was passed so no fork was actually created).
 * `strategy: 'ADMIN_APPROVAL_REQUIRED'` is a normal, expected outcome here,
 * not a thrown error — the caller (repository-fix-workflow-service.ts)
 * turns it into a FixWorkflowError only at actual-approval time.
 */
export interface PrStrategyResult {
  strategy: RepositoryFixPrStrategy | 'ADMIN_APPROVAL_REQUIRED';
  /** Human-readable explanation, safe to show directly in the UI — never includes a token or other secret. */
  detail: string;
  pushCredentials?: PushCredentials;
  /** USER_FORK only — the fork's owner login, used to format `CreatePullRequestParams.headOwner`. */
  forkOwner?: string;
  /** USER_FORK only — the fork's HTTPS clone URL, used as the git remote the branch is actually pushed to (never `origin`, which still points at the original repo). */
  forkCloneUrl?: string;
  /** Present for USER_DIRECT/USER_FORK (resolution already fetched the repo) — GITHUB_APP_DIRECT leaves this undefined so the workflow service's existing default-branch fallback chain runs unchanged. */
  defaultBranch?: string;
}

export class RepositoryProviderError extends Error {
  constructor(
    message: string,
    /** FORK_NOT_READY — GitHub accepted a fork request (or one already existed) but it hadn't finished provisioning within the bounded poll window; see GitHubProviderClient.resolvePrStrategy. Safe to retry. */
    public readonly category: 'AUTH_NOT_CONFIGURED' | 'AUTH_FAILED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'PROVIDER_UNSUPPORTED' | 'REQUEST_FAILED' | 'FORK_NOT_READY',
  ) {
    super(message);
    this.name = 'RepositoryProviderError';
  }
}

export interface RepositoryProviderClient {
  readonly provider: RepositoryFixPrProvider;
  /**
   * Phase 16/D: every method below is resolved for a SPECIFIC authenticated
   * user (userId is always request.user.id — never client-supplied),
   * exactly like getPushCredentials already was in Phase 16/C. This is what
   * makes "verify GitLab authorization can actually access this repository"
   * (a real per-user check, not just per-application) possible — see the
   * Phase 16/D report's audit section for why this widened beyond just push
   * credentials.
   *
   * Confirms the resolved credential can actually read this repository —
   * called before any branch/commit work starts, so an auth problem is
   * reported before anything is mutated.
   */
  validateRemoteAccess(userId: string, owner: string, repo: string, signal?: AbortSignal): Promise<void>;
  getRepositoryInfo(userId: string, owner: string, repo: string, signal?: AbortSignal): Promise<RepositoryInfo>;
  createPullRequest(userId: string, params: CreatePullRequestParams, signal?: AbortSignal): Promise<PullRequestInfo>;
  /**
   * Phase 16/C: resolves the credential for the SPECIFIC authenticated
   * user + repository this workflow belongs to (userId is always
   * request.user.id — the caller must never pass a client-supplied value).
   * GitHub resolves this against a real GitHub App installation
   * (provider-connection-service.ts); GitLab/Bitbucket still fall back to
   * their single server-side token (their own per-user OAuth connection is
   * a later phase — see the Phase 16 design report's Phase D/E). Throws
   * RepositoryProviderError('...', 'AUTH_NOT_CONFIGURED') if no usable
   * credential exists for this user+repo, so approval fails BEFORE any
   * branch is created (see the Phase 13 report's mutation-order section).
   */
  getPushCredentials(userId: string, owner: string, repo: string, signal?: AbortSignal): Promise<PushCredentials>;

  /**
   * OPTIONAL — only GitHubProviderClient implements this. Resolves which of
   * GITHUB_APP_DIRECT/USER_DIRECT/USER_FORK/ADMIN_APPROVAL_REQUIRED applies
   * for this specific user+repository, trying the existing App path
   * (getPushCredentials, unchanged) first and falling back to the user's
   * own direct-push OAuth connection only when the App can't reach this
   * repo. GitLab/Bitbucket have no such fork here, so this stays undefined
   * for them and every existing caller of getPushCredentials is unaffected.
   * `preview: true` performs every read-only check but never creates a
   * fork — for the UI's "which method will be used" preview.
   */
  resolvePrStrategy?(userId: string, owner: string, repo: string, signal?: AbortSignal, opts?: { preview?: boolean }): Promise<PrStrategyResult>;

  /**
   * OPTIONAL — only GitHubProviderClient implements this today (roadmap
   * Phase 7). Creates a plain GitHub issue, never a branch/commit/PR.
   * Resolves credentials through the exact same per-user App-installation
   * path createPullRequest already uses (githubRequest's resolveGitHubToken)
   * — never a second, parallel auth mechanism. GitLab/Bitbucket have no
   * implementation here yet, so this stays undefined for them.
   */
  createIssue?(userId: string, params: CreateGitHubIssueParams, signal?: AbortSignal): Promise<GitHubIssueInfo>;
}
