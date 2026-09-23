import { Link } from 'react-router-dom';
import type { AggregatedIssue, Issue } from '@origami/contracts';
import { CATEGORY_LABEL, SEVERITY_LABEL, STATUS_LABEL } from '../api/client';

interface Props {
  issue: Issue | AggregatedIssue;
  /** Display name for issue.repositoryId, if resolved (migration 019) — omitted/undefined for a finding with no repository chosen yet. Keyed by id since a card only ever needs its own issue's repository, never the full Repository object. */
  repositoryName?: string;
}

/**
 * Collapsed by design — Problem/Cause/Impact/Suggested Fix/Evidence all
 * still exist, just on the existing /issues/:id detail page ("View
 * details" below), not duplicated inline on every card. The whole card is
 * clickable via the "stretched link" pattern (a single real, visible link
 * whose ::after covers the card) rather than nesting an interactive
 * element inside another — one real link per card, full-card click target.
 */
export function IssueCard({ issue, repositoryName }: Props) {
  const severityClass = issue.severity.toLowerCase();
  const aggregated = 'occurrenceCount' in issue ? issue : null;
  const affectedCount = aggregated?.occurrenceCount ?? (issue.evidence.count && issue.evidence.count > 1 ? issue.evidence.count : undefined);

  return (
    <article className={`issue-card ${severityClass}`}>
      <div className="issue-card-top">
        <span className={`severity-badge ${severityClass}`}>{SEVERITY_LABEL[issue.severity]}</span>
        <h3 className="issue-card-title">{issue.title}</h3>
      </div>

      <p className="issue-card-meta">
        {CATEGORY_LABEL[issue.category] ?? issue.category} · {STATUS_LABEL[issue.status ?? 'open']}
        {repositoryName && <> · Repository: {repositoryName}</>}
      </p>

      <p className="issue-card-description">{issue.problem}</p>

      {affectedCount !== undefined && (
        <p className="issue-card-affected">Affected: {affectedCount} occurrence{affectedCount === 1 ? '' : 's'}</p>
      )}

      <Link to={`/issues/${issue.id}`} className="issue-card-action">
        View details <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

interface ListProps {
  issues: (Issue | AggregatedIssue)[];
  /** See IssueCard's repositoryName — omit entirely where repository context isn't relevant (unchanged from before migration 019). */
  repositoryNamesById?: Record<string, string>;
}

export function IssueList({ issues, repositoryNamesById }: ListProps) {
  if (issues.length === 0) {
    return (
      <div className="empty-state inline">
        <p>Great! No issues match your current filters.</p>
      </div>
    );
  }

  return (
    <div className="issue-list">
      {issues.map((issue) => (
        <IssueCard key={issue.id} issue={issue} repositoryName={issue.repositoryId ? repositoryNamesById?.[issue.repositoryId] : undefined} />
      ))}
    </div>
  );
}
