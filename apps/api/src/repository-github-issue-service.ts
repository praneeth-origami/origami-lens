import type { AggregatedIssue, CreateGitHubIssueResponse, GitHubIssueErrorCode, GitHubIssueLink, GitHubIssuePreview, Issue } from '@origami/contracts';
import { CATEGORY_LABEL } from '@origami/contracts';
import { RepositoryProviderError } from './repository-provider-client.js';
import type { CreateGitHubIssueParams, RepositoryProviderClient } from './repository-provider-client.js';
import { canAccessRepository, parseRepositoryUrl } from './repository-service.js';

export class GitHubIssueError extends Error {
  constructor(message: string, public readonly code: GitHubIssueErrorCode) {
    super(message);
    this.name = 'GitHubIssueError';
  }
}

function isAggregated(issue: Issue | AggregatedIssue): issue is AggregatedIssue {
  return 'occurrenceCount' in issue;
}

/** Lowercased, GitHub-label-safe strings — never invented beyond the finding's own category/severity. */
export function buildGitHubIssueLabels(issue: Issue | AggregatedIssue): string[] {
  const categoryLabel = CATEGORY_LABEL[issue.category].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return [categoryLabel, issue.severity.toLowerCase()];
}

/**
 * A useful, evidence-grounded issue body — every section is drawn directly
 * from the finding's own already-persisted fields, never invented. Matches
 * the roadmap's example shape (Problem/Page/Severity/Category/Selector/
 * Evidence/Suggested Fix/Origami Lens footer).
 */
export function buildGitHubIssueBody(issue: Issue | AggregatedIssue, pageUrl: string, healthScore: number | null): string {
  const lines: string[] = [];
  lines.push('## Problem', '', issue.problem, '');
  lines.push('## Page', '', pageUrl, '');
  lines.push('## Severity', '', issue.severity, '');
  lines.push('## Category', '', CATEGORY_LABEL[issue.category], '');
  if (issue.evidence.selector) lines.push('## Selector', '', `\`${issue.evidence.selector}\``, '');
  if (issue.evidence.message || issue.evidence.snippet) {
    lines.push('## Evidence', '');
    if (issue.evidence.message) lines.push(issue.evidence.message, '');
    if (issue.evidence.snippet) lines.push('```', issue.evidence.snippet, '```', '');
  }
  if (isAggregated(issue) && issue.occurrenceCount > 1) {
    lines.push('## Occurrences', '', `Detected on ${issue.occurrenceCount} page${issue.occurrenceCount === 1 ? '' : 's'} of this scan.`, '');
  }
  lines.push('## Suggested Fix', '', issue.suggestedFix, '');
  lines.push('## Origami Lens', '');
  lines.push(`Scan: ${issue.scanId ?? 'n/a'}`);
  lines.push(`Issue: ${issue.id}`);
  if (healthScore !== null) lines.push(`Health Score: ${healthScore}/100`);
  lines.push('', '_Filed automatically from an Origami Lens finding._');
  return lines.join('\n');
}

export function buildGitHubIssuePreview(
  repository: { repoUrl: string },
  issue: Issue | AggregatedIssue,
  pageUrl: string,
  healthScore: number | null,
): GitHubIssuePreview {
  const parsed = parseRepositoryUrl(repository.repoUrl);
  if (!parsed.ok) throw new GitHubIssueError('Could not resolve the repository owner/name from its URL.', 'REPOSITORY_NOT_FOUND');
  return {
    title: issue.title,
    body: buildGitHubIssueBody(issue, pageUrl, healthScore),
    labels: buildGitHubIssueLabels(issue),
    owner: parsed.value.owner,
    repo: parsed.value.name,
  };
}

/** Maps a RepositoryProviderError (see repository-github-provider-client.ts) onto this feature's own error taxonomy. A 403 is classified upstream as RATE_LIMITED (classifyStatus's existing, PR-creation-tuned mapping) — for issue creation specifically, a 403 is much more often a missing "Issues: write" App permission than a genuine rate limit, so it's surfaced as GITHUB_PERMISSION_DENIED with wording that honestly covers both possibilities rather than confidently mislabeling either way. */
export function mapProviderError(error: RepositoryProviderError): GitHubIssueError {
  switch (error.category) {
    case 'AUTH_NOT_CONFIGURED':
    case 'AUTH_FAILED':
      return new GitHubIssueError(error.message, 'GITHUB_AUTH_NOT_CONFIGURED');
    case 'RATE_LIMITED':
      return new GitHubIssueError('GitHub rejected this request — the connected GitHub App may not have permission to create issues on this repository, or the request was rate-limited.', 'GITHUB_PERMISSION_DENIED');
    case 'NOT_FOUND':
      return new GitHubIssueError('Repository not found on GitHub, or the connection cannot see it.', 'REPOSITORY_NOT_FOUND');
    default:
      return new GitHubIssueError(error.message, 'GITHUB_REQUEST_FAILED');
  }
}

export interface GitHubIssueLinkStore {
  findGitHubIssueLink(issueId: string, repositoryId: string, provider: string): Promise<GitHubIssueLink | undefined>;
  linkGitHubIssue(
    issueId: string,
    link: { repositoryId: string; provider: string; githubOwner: string; githubRepository: string; issueNumber: number; issueUrl: string; createdByUserId?: string },
  ): Promise<{ alreadyExisted: boolean; link: GitHubIssueLink } | undefined>;
}

export interface CreateGitHubIssueDeps {
  provider: RepositoryProviderClient;
  store: GitHubIssueLinkStore;
}

/**
 * Serializes concurrent create-github-issue calls for the SAME
 * finding+repository+provider within this process (bugfix: duplicate
 * GitHub issues from near-simultaneous requests) — keyed per
 * finding+repository+provider so creating against two different
 * repositories for the same finding never blocks on each other. A second
 * call arriving while the first is still in flight joins the first's
 * promise and gets its exact result instead of calling GitHub again. This
 * is a single-process guarantee (matches this app's single-instance
 * deployment, see scan-store.ts's own in-memory store); the
 * UNIQUE(issue_id, repository_id, provider) constraint backing
 * GitHubIssueLinkStore.linkGitHubIssue is the last line of defense beyond
 * that — see its doc comment.
 */
const inFlightCreations = new Map<string, Promise<CreateGitHubIssueResponse>>();

/**
 * Create GitHub Issue (roadmap Phase 7) — resolves repositoryId -> owner/repo
 * -> the SAME per-user GitHub App credential chain createPullRequest already
 * uses (never a second auth mechanism, never assumes "the first" GitHub
 * account), then creates a plain issue. Distinct from the Fix-with-AI -> PR
 * workflow: never creates a branch, commit, or PR.
 *
 * Idempotent (bugfix: duplicate GitHub issues) — a finding may be filed in
 * more than one repository, but never twice in the SAME repository
 * (migration 040): if `issue.githubIssueLinks` (loaded fresh by the caller)
 * already has a link for this exact repository+provider, that link is
 * returned immediately, with `alreadyExisted: true`, and GitHub is never
 * called. Repeated clicks, a page reload, or re-opening the issue all see
 * this same persisted state — never only resettable React state.
 */
export async function createGitHubIssueForFinding(
  userId: string,
  repository: { id: string; organizationId?: string; repoUrl: string; provider?: string } | undefined,
  callerOrganizationId: string | undefined,
  issue: Issue | AggregatedIssue,
  pageUrl: string,
  healthScore: number | null,
  overrides: { title?: string; body?: string; labels?: string[] },
  deps: CreateGitHubIssueDeps,
  signal?: AbortSignal,
): Promise<CreateGitHubIssueResponse> {
  const providerName = repository?.provider ?? 'GITHUB';

  if (repository) {
    const existing = issue.githubIssueLinks?.find((l) => l.repositoryId === repository.id && l.provider === providerName);
    if (existing) return { issueNumber: existing.issueNumber, issueUrl: existing.issueUrl, alreadyExisted: true };
  }

  if (!repository) throw new GitHubIssueError('Repository not found.', 'REPOSITORY_NOT_FOUND');
  if (!canAccessRepository(repository.organizationId, callerOrganizationId)) {
    throw new GitHubIssueError('Repository not found.', 'REPOSITORY_ACCESS_DENIED');
  }
  const createIssue = deps.provider.createIssue;
  if (!createIssue) {
    throw new GitHubIssueError(`Creating a GitHub issue is not yet supported for provider "${repository.provider ?? 'unknown'}".`, 'PROVIDER_UNSUPPORTED');
  }

  const parsed = parseRepositoryUrl(repository.repoUrl);
  if (!parsed.ok) throw new GitHubIssueError('Could not resolve the repository owner/name from its URL.', 'REPOSITORY_NOT_FOUND');

  const lockKey = `${issue.id}:${repository.id}:${providerName}`;
  const inFlight = inFlightCreations.get(lockKey);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<CreateGitHubIssueResponse> => {
    try {
      // Re-check right before calling GitHub — catches a link recorded by a
      // request that started (and finished) before this one entered the
      // in-process lock above, e.g. right after a process restart.
      const fresh = await deps.store.findGitHubIssueLink(issue.id, repository.id, providerName);
      if (fresh) return { issueNumber: fresh.issueNumber, issueUrl: fresh.issueUrl, alreadyExisted: true };

      const params: CreateGitHubIssueParams = {
        owner: parsed.value.owner,
        repo: parsed.value.name,
        title: overrides.title ?? issue.title,
        body: overrides.body ?? buildGitHubIssueBody(issue, pageUrl, healthScore),
        labels: overrides.labels ?? buildGitHubIssueLabels(issue),
      };

      const result = await createIssue(userId, params, signal);
      const linked = await deps.store.linkGitHubIssue(issue.id, {
        repositoryId: repository.id,
        provider: providerName,
        githubOwner: parsed.value.owner,
        githubRepository: parsed.value.name,
        issueNumber: result.number,
        issueUrl: result.url,
        createdByUserId: userId,
      });
      if (!linked) throw new GitHubIssueError('Failed to record the created GitHub issue.', 'GITHUB_REQUEST_FAILED');
      // alreadyExisted here means the DB's unique constraint rejected OUR
      // insert because a different process's insert won the race first —
      // return THAT link, never our own, so the system only ever reports
      // one issue number for this finding+repository even then.
      return { issueNumber: linked.link.issueNumber, issueUrl: linked.link.issueUrl, alreadyExisted: linked.alreadyExisted };
    } catch (error) {
      if (error instanceof GitHubIssueError) throw error;
      if (error instanceof RepositoryProviderError) throw mapProviderError(error);
      throw new GitHubIssueError(error instanceof Error ? error.message : 'Failed to create the GitHub issue.', 'GITHUB_REQUEST_FAILED');
    } finally {
      inFlightCreations.delete(lockKey);
    }
  })();
  inFlightCreations.set(lockKey, promise);
  return promise;
}
