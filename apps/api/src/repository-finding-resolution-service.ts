import type { Issue, Repository, RepositoryResolution } from '@origami/contracts';

/**
 * Same set every fix-generation/search path already uses (repository-search-
 * service.ts, repository-fix-workflow-service.ts, repository-fix-application-
 * service.ts) to mean "not yet usable for search/fix generation" — duplicated
 * here rather than shared, matching this codebase's existing convention for
 * this exact constant.
 */
const NOT_YET_INDEXED_STATUSES = new Set(['CONNECTED', 'DISCONNECTED', 'CLONING', 'READY_FOR_INDEXING', 'INDEXING', 'FAILED']);

function isUsable(repository: Repository): boolean {
  return !NOT_YET_INDEXED_STATUSES.has(repository.status);
}

/**
 * Resolves which repository a scan finding's AI fix/PR should target.
 *
 * A scan finding has no inherent link to a repository (see IssueDetailPage.tsx's
 * Phase 10 comment) — historically the user just picked one from a dropdown,
 * fresh, every single time. This function is the one place that decides
 * whether a pick is even necessary:
 *
 *   - the finding already has a repositoryId, and that repository is still
 *     one of the caller's own → 'resolved' (nothing to ask, the choice was
 *     already made and persisted)
 *   - no usable repository is connected at all → 'none'
 *   - exactly one usable repository is connected → 'resolved' (there is no
 *     real choice to make — covers both today's single-full-stack-repo case
 *     and a project that has only connected its frontend OR backend so far)
 *   - two or more usable repositories, and no persisted choice → 'unresolved'
 *
 * Deliberately never guesses between multiple candidates by category, file
 * path, or any other heuristic — the spec this was built against explicitly
 * warns against an aggressive/incorrect auto-assignment, and the existing
 * manual picker already lets a human decide safely once repositories are
 * labeled by role (see RepositoriesListPage.tsx).
 */
export function resolveRepositoryForIssue(issue: Pick<Issue, 'repositoryId'>, repositories: Repository[]): RepositoryResolution {
  if (issue.repositoryId) {
    const chosen = repositories.find((r) => r.id === issue.repositoryId);
    if (chosen) return { status: 'resolved', repository: chosen };
    // The persisted repository no longer belongs to this caller (or was
    // deleted) — fall through to the normal resolution as if nothing had
    // been chosen yet, rather than silently trusting a stale/foreign id.
  }

  const usable = repositories.filter(isUsable);
  if (usable.length === 0) return { status: 'none' };
  if (usable.length === 1) return { status: 'resolved', repository: usable[0] };
  return { status: 'unresolved', candidates: usable };
}

export class FindingRepositoryMismatchError extends Error {
  constructor() {
    super('This finding already has a different repository recorded against it.');
    this.name = 'FindingRepositoryMismatchError';
  }
}

/**
 * Guards the fix-proposal generation route (index.ts): once a finding has a
 * repository recorded against it (see setIssueRepositoryAsync, called after
 * a first successful generation), a later attempt to generate against a
 * DIFFERENT repository is rejected rather than silently redirected. A
 * finding with no repositoryId yet, or one that already matches, is fine —
 * the caller is either making the very first choice or repeating the same
 * one.
 */
export function assertFindingRepositoryMatches(issue: Pick<Issue, 'repositoryId'>, repositoryId: string): void {
  if (issue.repositoryId && issue.repositoryId !== repositoryId) {
    throw new FindingRepositoryMismatchError();
  }
}
