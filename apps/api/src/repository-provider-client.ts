import type { RepositoryFixPrProvider } from '@origami/contracts';

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

export class RepositoryProviderError extends Error {
  constructor(
    message: string,
    public readonly category: 'AUTH_NOT_CONFIGURED' | 'AUTH_FAILED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'PROVIDER_UNSUPPORTED' | 'REQUEST_FAILED',
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
}
