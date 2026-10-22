import { useState } from 'react';
import type { Issue, ResponsiveViewportResult } from '@origami/contracts';
import { ApiRequestError, runResponsiveTest } from '../api/client';
import { SEVERITY_LABEL } from '../api/client';

interface Props {
  url: string;
}

/**
 * Renders its own issue rows rather than reusing IssueCard/IssueList — those
 * link to /issues/:id, which only resolves for a real, persisted scan
 * finding. Responsive Testing is deliberately an on-demand, unpersisted
 * check (see responsive-test-service.ts): its issues have no such route to
 * link to.
 */
function ResponsiveIssueRow({ issue }: { issue: Issue }) {
  const severityClass = issue.severity.toLowerCase();
  return (
    <div className={`issue-card ${severityClass} responsive-issue-row`}>
      <div className="issue-card-top">
        <span className={`severity-badge ${severityClass}`}>{SEVERITY_LABEL[issue.severity]}</span>
        <h4 className="issue-card-title">{issue.title}</h4>
      </div>
      <p className="issue-card-description">{issue.problem}</p>
      <p className="muted">{issue.suggestedFix}</p>
    </div>
  );
}

function ViewportResultCard({ result }: { result: ResponsiveViewportResult }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="responsive-viewport-card">
      <button type="button" className="responsive-viewport-header" onClick={() => setExpanded((e) => !e)} disabled={result.issueCount === 0}>
        <span className="responsive-viewport-label">{result.label}</span>
        <span className={`responsive-viewport-count ${result.issueCount === 0 ? 'ok' : 'has-issues'}`}>
          {result.issueCount === 0 ? '0 problems' : `${result.issueCount} problem${result.issueCount === 1 ? '' : 's'}`}
        </span>
      </button>
      {expanded && result.issueCount > 0 && (
        <div className="responsive-viewport-issues">
          {result.issues.map((issue) => <ResponsiveIssueRow key={issue.id} issue={issue} />)}
        </div>
      )}
    </div>
  );
}

/** "Test Responsive" — Automatic Responsive Testing (roadmap Phase 4). Renders the given URL at the standard breakpoints and shows a per-width problem count, expandable to the real findings. */
export function ResponsiveTestPanel({ url }: Props) {
  const [loading, setLoading] = useState(false);
  const [viewports, setViewports] = useState<ResponsiveViewportResult[] | null>(null);
  const [error, setError] = useState('');

  const run = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await runResponsiveTest(url);
      setViewports(result.viewports);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Responsive test failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="ai-section responsive-test-panel">
      <div className="ai-section-heading">
        <div>
          <h3>Responsive Test</h3>
          <p className="muted">Checks this page at 375px, 390px, 430px, 768px, 1024px, and desktop for overflow, off-screen elements, and overlapping navigation.</p>
        </div>
      </div>

      <button type="button" className="primary-button" onClick={run} disabled={loading}>
        {loading ? 'Testing…' : 'Test Responsive'}
      </button>

      {error && <p className="ai-response ai-response-error">{error}</p>}

      {viewports && (
        <div className="responsive-viewport-grid">
          {viewports.map((v) => <ViewportResultCard key={v.width} result={v} />)}
        </div>
      )}
    </section>
  );
}
