import { Link } from 'react-router-dom';
import type { AggregatedIssue, GitHubIssueLink, Issue, IssueStatus, Repository } from '@origami/contracts';
import { CATEGORY_LABEL, SEVERITY_LABEL, SOURCE_LABEL, STATUS_LABEL } from '../api/client';
import { CreateGitHubIssueButton } from './CreateGitHubIssueButton';

interface Props {
  issue: Issue | AggregatedIssue;
  scanId: string;
  scanUrl: string;
  scannedAt: string;
  onShare: () => void;
  onExport: () => void;
  onStatusChange: (status: IssueStatus) => void;
  actionMessage: string;
  /** Threaded straight through to CreateGitHubIssueButton, now rendered here instead of at the bottom of the page — see that component's doc comment. Shared with IssueFixWithAi's own repository picker, never a second/duplicated one. */
  repositories: Repository[];
  selectedRepoId: string;
  setSelectedRepoId: (id: string) => void;
  reloadRepositories: () => void;
  /** Bugfix (duplicate GitHub issues): called with the persisted link right after a successful create, so IssueDetailPage can patch its loaded issue's own githubIssueLinks without a full refetch. */
  onGitHubIssueLinked: (link: GitHubIssueLink) => void;
}

/** Same single-purpose relative-time helper duplicated in ScanSummary.tsx — this codebase's existing convention rather than sharing a util for one small display line. */
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function affectedCount(issue: Issue | AggregatedIssue): number {
  if ('occurrenceCount' in issue && issue.occurrenceCount) return issue.occurrenceCount;
  if (typeof issue.evidence.count === 'number' && issue.evidence.count > 0) return issue.evidence.count;
  return 1;
}

export function IssueHeader({ issue, scanId, scanUrl, scannedAt, onShare, onExport, onStatusChange, actionMessage, repositories, selectedRepoId, setSelectedRepoId, reloadRepositories, onGitHubIssueLinked }: Props) {
  const severityClass = issue.severity.toLowerCase();
  const status = issue.status ?? 'open';
  const description = (issue.evidence.message && String(issue.evidence.message)) || issue.problem;
  const count = affectedCount(issue);
  const firstSeen = issue.createdAt ?? scannedAt;

  return (
    <header className="issue-header-card">
      <div className="issue-detail-topbar">
        <Link to={`/scans/${scanId}`} className="ghost-button back-link">← Back to Issues</Link>

        <div className="issue-detail-actions">
          <button type="button" className="ghost-button" onClick={onShare}>Share</button>
          <button type="button" className="ghost-button" onClick={onExport}>Export</button>
          <CreateGitHubIssueButton
            issueId={issue.id}
            githubIssueLinks={issue.githubIssueLinks}
            repositories={repositories}
            selectedRepoId={selectedRepoId}
            setSelectedRepoId={setSelectedRepoId}
            reloadRepositories={reloadRepositories}
            onLinked={onGitHubIssueLinked}
          />
          {status === 'resolved' ? (
            <button type="button" className="primary-button" onClick={() => onStatusChange('open')}>Reopen Issue</button>
          ) : (
            <button type="button" className="primary-button" onClick={() => onStatusChange('resolved')}>Mark as Resolved</button>
          )}
        </div>
      </div>

      {actionMessage && <p className="detail-action-message issue-header-action-message">{actionMessage}</p>}

      <div className="issue-badge-row">
        <span className={`severity-badge ${severityClass}`}>{SEVERITY_LABEL[issue.severity]}</span>
        <span className="badge category-badge">{CATEGORY_LABEL[issue.category]}</span>
        <label className="status-badge-select">
          <span className="sr-only">Issue status</span>
          <select value={status} onChange={(e) => onStatusChange(e.target.value as IssueStatus)}>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>

      <h1 className="issue-header-title">{issue.title}</h1>
      <p className="issue-header-description">{description}</p>

      <div className="issue-meta-row">
        <a href={scanUrl} target="_blank" rel="noreferrer" className="issue-meta-item issue-meta-link">{scanUrl}</a>
        <span className="issue-meta-item">Detected by {SOURCE_LABEL[issue.source]}</span>
        <span className="issue-meta-item">First seen {relativeTime(firstSeen)}</span>
        <span className="issue-meta-item">{count} affected {count === 1 ? 'element' : 'elements'}</span>
      </div>
    </header>
  );
}
