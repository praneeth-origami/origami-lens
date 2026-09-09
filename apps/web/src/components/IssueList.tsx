import { Link } from 'react-router-dom';
import type { AggregatedIssue, Issue } from '@origami/contracts';
import { CATEGORY_LABEL, SEVERITY_LABEL, STATUS_LABEL } from '../api/client';
import { IssueEvidence } from './IssueEvidence';

interface Props {
  issue: Issue | AggregatedIssue;
}

export function IssueCard({ issue }: Props) {
  const severityClass = issue.severity.toLowerCase();
  const aggregated = 'occurrenceCount' in issue ? issue : null;

  return (
    <article className={`issue-card ${severityClass}`}>
      <header>
        <span className={`severity-badge ${severityClass}`}>{SEVERITY_LABEL[issue.severity]}</span>
        <h3>{issue.title}</h3>
      </header>

      <dl className="issue-meta">
        <div>
          <dt>Category</dt>
          <dd>{CATEGORY_LABEL[issue.category] ?? issue.category}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{STATUS_LABEL[issue.status ?? 'open']}</dd>
        </div>
        {aggregated && (
          <div>
            <dt>Affected pages</dt>
            <dd>{aggregated.occurrenceCount} occurrence(s) on {aggregated.affectedPages.length} page(s)</dd>
          </div>
        )}
      </dl>

      <div className="issue-body">
        <p><strong>Problem:</strong> {issue.problem}</p>
        <p><strong>Cause:</strong> {issue.cause}</p>
        <p><strong>Impact:</strong> {issue.impact}</p>
        <p><strong>Suggested Fix:</strong> {issue.suggestedFix}</p>
      </div>

      <IssueEvidence issue={issue} compact />

      <Link to={`/issues/${issue.id}`} className="btn-view">
        View Issue
      </Link>
    </article>
  );
}

interface ListProps {
  issues: (Issue | AggregatedIssue)[];
}

export function IssueList({ issues }: ListProps) {
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
        <IssueCard key={issue.id} issue={issue} />
      ))}
    </div>
  );
}
