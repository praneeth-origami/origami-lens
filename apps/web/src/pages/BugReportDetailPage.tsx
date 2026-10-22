import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { BugReport, Repository } from '@origami/contracts';
import { CATEGORY_LABEL } from '@origami/contracts';
import { ApiRequestError, createGitHubIssueFromBugReport, fetchBugReport, fetchRepositories, SEVERITY_LABEL } from '../api/client';
import { ErrorState, LoadingSkeleton } from '../components/StateViews';
import { lensEvent } from '../notifications/lens-event';
import { PullRequestIcon, GitHubIcon } from '../components/icons';

/** Same relative-time helper duplicated across IssueHeader.tsx/ScanSummary.tsx — this codebase's existing convention for small single-purpose display helpers. */
function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/**
 * Bugfix: a bug report's GitHub issue link is now PERMANENT once created
 * (migration 039) — this reads it straight off the report on load (not
 * just local state that resets on every refresh), so reopening this page
 * after creating an issue shows the EXISTING link immediately instead of
 * offering a "Create Issue" button that would file a second, duplicate
 * issue. The backend is independently idempotent too (createGitHubIssueFromBugReport
 * returns the existing link rather than calling GitHub again), so even a
 * stray duplicate click can never create a second issue.
 */
function GitHubIssueSection({ report }: { report: BugReport }) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ issueNumber: number; issueUrl: string } | null>(
    report.githubIssueUrl && report.githubIssueNumber !== undefined
      ? { issueNumber: report.githubIssueNumber, issueUrl: report.githubIssueUrl }
      : null,
  );

  useEffect(() => {
    if (result) return; // already linked — no need to load the repository picker at all
    fetchRepositories().then((res) => setRepositories(res.repositories)).catch(() => setRepositories([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!result && repositories.length === 0) return null;

  const handleCreate = async () => {
    if (!selectedRepoId) return;
    setCreating(true);
    setError('');
    try {
      const response = await createGitHubIssueFromBugReport(report.id, selectedRepoId);
      setResult(response);
      lensEvent.success('GitHub issue created', { resource: `#${response.issueNumber}`, icon: <PullRequestIcon /> });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create the GitHub issue.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="ai-section">
      <div className="ai-section-heading">
        <div>
          <h3>Create GitHub Issue</h3>
          <p className="muted">Files this bug report as a plain GitHub issue in the selected repository.</p>
        </div>
      </div>

      {result ? (
        <p className="ai-response">
          Issue #{result.issueNumber} created.{' '}
          <a href={result.issueUrl} target="_blank" rel="noreferrer">View on GitHub →</a>
        </p>
      ) : (
        <div className="ask-row">
          <select className="search-input" value={selectedRepoId} onChange={(e) => setSelectedRepoId(e.target.value)} aria-label="Repository">
            <option value="">Select a repository…</option>
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>{repo.repoUrl.replace(/^https?:\/\//, '')}</option>
            ))}
          </select>
          <button type="button" className="primary-button" onClick={() => void handleCreate()} disabled={creating || !selectedRepoId}>
            <GitHubIcon /> {creating ? 'Creating…' : 'Create Issue'}
          </button>
        </div>
      )}
      {error && <p className="ai-response ai-response-error">{error}</p>}
    </section>
  );
}

export function BugReportDetailPage() {
  const { id } = useParams();
  const [report, setReport] = useState<BugReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetchBugReport(id)
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : 'Bug report not found'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div className="dashboard"><LoadingSkeleton /></div>;
  }
  if (error || !report) {
    return <div className="dashboard"><ErrorState message={error ?? 'Bug report not found'} /></div>;
  }

  const severityClass = report.severity.toLowerCase();

  return (
    <div className="dashboard issue-detail-page">
      <header className="issue-header-card">
        <div className="issue-detail-topbar">
          <Link to="/" className="ghost-button back-link">← Back to Dashboard</Link>
        </div>

        <div className="issue-badge-row">
          <span className={`severity-badge ${severityClass}`}>{SEVERITY_LABEL[report.severity]}</span>
          <span className="badge category-badge">{CATEGORY_LABEL[report.category]}</span>
        </div>

        <h1 className="issue-header-title">{report.title}</h1>

        <div className="issue-meta-row">
          <a href={report.url} target="_blank" rel="noreferrer" className="issue-meta-item issue-meta-link">{report.url}</a>
          <span className="issue-meta-item">{report.browser}</span>
          <span className="issue-meta-item">{report.operatingSystem}</span>
          <span className="issue-meta-item">{report.viewportWidth} × {report.viewportHeight} (DPR {report.devicePixelRatio})</span>
          <span className="issue-meta-item">Detected {formatDateTime(report.createdAt)}</span>
        </div>
      </header>

      <div className="issue-detail-layout">
        <div className="issue-detail-main">
          <article className="detail-card">
            <h3>What Happened</h3>
            <p>{report.description}</p>
          </article>

          {report.reproductionSteps.length > 0 && (
            <article className="detail-card">
              <h3>Reproduction Steps</h3>
              <ol className="repro-steps-list">
                {report.reproductionSteps.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            </article>
          )}

          {report.hasScreenshot && (
            <article className="detail-card">
              <h3>Screenshot</h3>
              <img src={`/api/bug-reports/${report.id}/screenshot`} alt="Screenshot at time of report" className="screenshot-image" />
            </article>
          )}

          {report.consoleErrors.length > 0 && (
            <article className="detail-card">
              <h3>Console Errors</h3>
              <pre>{report.consoleErrors.map((e) => `[${e.type}] ${e.message}${e.stack ? `\n${e.stack}` : ''}`).join('\n\n')}</pre>
            </article>
          )}

          {report.networkErrors.length > 0 && (
            <article className="detail-card">
              <h3>Network Errors</h3>
              <pre>{report.networkErrors.map((e) => `${e.method} ${e.url} → ${e.status}`).join('\n')}</pre>
            </article>
          )}

          {report.domEvidence && (
            <article className="detail-card">
              <h3>DOM / Element Evidence</h3>
              <p><strong>Selector:</strong> <span className="repository-commit-sha">{report.domEvidence.selector}</span></p>
              {report.domEvidence.accessibleName && <p><strong>Accessible name:</strong> {report.domEvidence.accessibleName}</p>}
              <pre>{report.domEvidence.html}</pre>
              {Object.keys(report.domEvidence.computedStyles).length > 0 && (
                <pre>{Object.entries(report.domEvidence.computedStyles).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>
              )}
            </article>
          )}

          {(report.expectedBehavior || report.actualBehavior) && (
            <article className="detail-card">
              {report.expectedBehavior && <><h3>Expected Behavior</h3><p>{report.expectedBehavior}</p></>}
              {report.actualBehavior && <><h3>Actual Behavior</h3><p>{report.actualBehavior}</p></>}
            </article>
          )}

          {report.suggestedFix && (
            <article className="detail-card">
              <h3>Suggested Fix</h3>
              <p>{report.suggestedFix}</p>
            </article>
          )}

          <GitHubIssueSection report={report} />

          <article className="detail-card">
            <h3>Technical Evidence</h3>
            <p className="repository-commit-sha">Bug Report: {report.id}</p>
            {report.linkedIssueId && <p className="repository-commit-sha">Linked Issue: {report.linkedIssueId}</p>}
            {report.linkedScanId && <p className="repository-commit-sha">Linked Scan: {report.linkedScanId}</p>}
            <p className="repository-commit-sha">Timestamp: {report.createdAt}</p>
          </article>
        </div>
      </div>
    </div>
  );
}
