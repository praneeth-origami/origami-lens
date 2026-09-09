import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AggregatedIssue, Issue, IssueStatus } from '@origami/contracts';
import {
  askAi,
  CATEGORY_LABEL,
  fetchIssue,
  fetchScan,
  SEVERITY_LABEL,
  STATUS_LABEL,
  suggestFix,
  updateIssueStatus,
} from '../api/client';
import { IssueEvidence } from '../components/IssueEvidence';
import { ErrorState, LoadingSkeleton } from '../components/StateViews';
import { ScreenshotViewer } from '../components/ScreenshotViewer';

export function IssueDetailPage() {
  const { issueId } = useParams();
  const [issue, setIssue] = useState<Issue | AggregatedIssue | null>(null);
  const [scanMeta, setScanMeta] = useState<{ scanId: string; url: string; scannedAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [askInput, setAskInput] = useState('Why is this happening?');
  const [askResponse, setAskResponse] = useState('');
  const [fixResponse, setFixResponse] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [scanArtifacts, setScanArtifacts] = useState<
    Awaited<ReturnType<typeof fetchScan>>['artifacts']
  >(undefined);

  useEffect(() => {
    if (!issueId) return;
    setLoading(true);
    fetchIssue(issueId)
      .then(async (data) => {
        setIssue(data.issue);
        setScanMeta(data.scan);
        try {
          const scan = await fetchScan(data.scan.scanId);
          setScanArtifacts(scan.artifacts);
        } catch {
          // Screenshots optional if scan metadata unavailable
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Issue not found'))
      .finally(() => setLoading(false));
  }, [issueId]);

  const handleStatusChange = async (status: IssueStatus) => {
    if (!issue) return;
    const updated = await updateIssueStatus(issue.id, status);
    setIssue(updated.issue);
  };

  const handleAsk = async () => {
    if (!issue || !scanMeta) return;
    setAiLoading(true);
    setAskResponse('');
    try {
      const res = await askAi(askInput, issue, scanMeta.url);
      setAskResponse(res.answer + (res.aiAvailable ? '' : ' (Deterministic fallback — AI unavailable)'));
    } catch {
      setAskResponse('AI explanation unavailable.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleSuggestFix = async () => {
    if (!issue || !scanMeta) return;
    setAiLoading(true);
    setFixResponse('');
    try {
      const res = await suggestFix(issue, scanMeta.url);
      const fix = res.fix as { fix?: string; explanation?: string };
      setFixResponse(
        fix.fix || fix.explanation || JSON.stringify(res.fix, null, 2) ||
          (res.aiAvailable ? '' : 'AI unavailable — see deterministic suggested fix above.'),
      );
    } catch {
      setFixResponse('Suggested fix unavailable.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleShareIssue = async () => {
    if (!issue || !scanMeta) return;

    const shareUrl = `${window.location.origin}${window.location.pathname}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: issue.title,
          text: `${issue.title} — ${scanMeta.url}`,
          url: shareUrl,
        });
        setActionMessage('Issue shared successfully.');
        return;
      }

      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(shareUrl);
        setActionMessage('Issue link copied to clipboard.');
        return;
      }

      setActionMessage('Sharing is not available in this browser.');
    } catch {
      setActionMessage('Share cancelled or unavailable.');
    }
  };

  const handleExportIssue = () => {
    if (!issue || !scanMeta) return;

    const payload = {
      scanId: scanMeta.scanId,
      issueId: issue.id,
      url: scanMeta.url,
      title: issue.title,
      severity: issue.severity,
      category: issue.category,
      status: issue.status ?? 'open',
      source: issue.source,
      problem: issue.problem,
      cause: issue.cause,
      impact: issue.impact,
      suggestedFix: issue.suggestedFix,
      evidence: issue.evidence,
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `issue-${issue.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);

    setActionMessage('Issue exported as JSON.');
  };

  if (loading) {
    return (
      <div className="dashboard">
        <LoadingSkeleton />
      </div>
    );
  }

  if (error || !issue || !scanMeta) {
    return (
      <div className="dashboard">
        <ErrorState message={error ?? 'Issue not found'} />
        <Link to="/" className="">← Back to Dashboard</Link>
      </div>
    );
  }

  const severityClass = issue.severity.toLowerCase();

  return (
    <div className="dashboard issue-detail-page">
      <div className="issue-detail-topbar">
        <Link to={`/scans/${scanMeta.scanId}`} className="primary-button">← Back to Dashboard</Link>

        <div className="issue-detail-actions">
          <button type="button" className="ghost-button" onClick={handleShareIssue}>Share</button>
          <button type="button" className="primary-button" onClick={handleExportIssue}>Export</button>
        </div>
      </div>

      <header className="issue-detail-header">
        <span className={`severity-badge ${severityClass}`}>{SEVERITY_LABEL[issue.severity]}</span>
        <h1>{issue.title}</h1>
        <div className="detail-tags">
          <span>{CATEGORY_LABEL[issue.category]}</span>
          <span>{STATUS_LABEL[issue.status ?? 'open']}</span>
          <a href={scanMeta.url} target="_blank" rel="noreferrer">{scanMeta.url}</a>
        </div>
      </header>

      <div className="detail-grid">
        <section>
          <h3>Problem</h3>
          <p>{issue.problem}</p>
        </section>
        <section>
          <h3>Cause</h3>
          <p>{issue.cause}</p>
        </section>
        <section>
          <h3>Impact</h3>
          <p>{issue.impact}</p>
        </section>
        <section>
          <h3>Suggested Fix</h3>
          <p>{issue.suggestedFix}</p>
        </section>
      </div>

      <IssueEvidence issue={issue} />

      {'occurrences' in issue && issue.occurrences.length > 0 && (
        <section className="occurrences-section">
          <h3>Affected Pages ({issue.affectedPages.length})</h3>
          <ul className="occurrences-list">
            {issue.occurrences.map((occ, idx) => (
              <li key={`${occ.pageScanId}-${idx}`}>
                <a href={occ.url} target="_blank" rel="noreferrer">{occ.url}</a>
                <details>
                  <summary>Evidence</summary>
                  <pre>{JSON.stringify(occ.evidence, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(issue.category === 'visualMobile' || issue.source === 'vision-ai') && scanMeta && (
        <ScreenshotViewer scanId={scanMeta.scanId} artifacts={scanArtifacts} />
      )}

      <div className="status-control">
        <label htmlFor="status-select">Status</label>
        <select
          id="status-select"
          value={issue.status ?? 'open'}
          onChange={(e) => handleStatusChange(e.target.value as IssueStatus)}
        >
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      <div className="ai-section">
        <h3>Ask AI</h3>
        <div className="ask-row">
          <input value={askInput} onChange={(e) => setAskInput(e.target.value)} />
          <button type="button" className="ghost-button" onClick={handleAsk} disabled={aiLoading}>Ask AI</button>
        </div>
        {askResponse && <p className="ai-response">{askResponse}</p>}

        <div className="ai-actions">
          <button type="button" className="primary-button" onClick={handleSuggestFix} disabled={aiLoading}>
            Suggested Fix (AI)
          </button>
        </div>
        {fixResponse && <pre className="ai-response">{fixResponse}</pre>}
        {actionMessage && <p className="detail-action-message">{actionMessage}</p>}
      </div>
    </div>
  );
}
