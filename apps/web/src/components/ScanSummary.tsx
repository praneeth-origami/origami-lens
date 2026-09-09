import { useState } from 'react';
import type { IssueCategory, ScanListItem, ScanResponse } from '@origami/contracts';
import { CATEGORY_LABEL } from '../api/client';

interface Props {
  scan: ScanResponse & { issuesByCategory?: Record<string, number> };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

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

interface ScanSummaryProps extends Props {
  scans: ScanListItem[];
  activeScanId?: string;
  onSelectScan: (scanId: string) => void;
}

export function ScanSummary({ scan, scans, activeScanId, onSelectScan }: ScanSummaryProps) {
  const [actionMessage, setActionMessage] = useState('');
  const host = hostnameOf(scan.url);

  const scannedDate = new Date(scan.scannedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const handleShare = async () => {
    const shareUrl = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: `${host} — Origami Lens`, text: `Website health report for ${host}`, url: shareUrl });
        setActionMessage('Shared successfully.');
        return;
      }
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(shareUrl);
        setActionMessage('Report link copied to clipboard.');
        return;
      }
      setActionMessage('Sharing is not available in this browser.');
    } catch {
      setActionMessage('Share cancelled or unavailable.');
    } finally {
      setTimeout(() => setActionMessage(''), 3000);
    }
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(scan, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `origami-lens-${host}-${scan.scanId.slice(0, 8)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setActionMessage('Report exported as JSON.');
    setTimeout(() => setActionMessage(''), 3000);
  };

  return (
    <section className="scan-summary animate-in">
      <div className="scan-summary-topbar">
        <div className="scan-summary-brand">
          <div className="site-thumb" aria-hidden="true" />
          <div>
            <div className="site-name-row">
              <span className="site-name">{host}</span>
              {scans.length > 1 && (
                <select
                  className="scan-switcher"
                  value={activeScanId ?? scan.scanId}
                  onChange={(e) => onSelectScan(e.target.value)}
                  aria-label="Switch scan"
                >
                  {scans.map((s) => (
                    <option key={s.scanId} value={s.scanId}>
                      {hostnameOf(s.url)} · {new Date(s.scannedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="site-url">{scan.url}</div>
          </div>
        </div>

        <div className="scan-summary-actions">
          {actionMessage && <span className="detail-action-message">{actionMessage}</span>}
          <button type="button" className="ghost-button" onClick={handleShare}>Share</button>
          <button type="button" className="primary-button" onClick={handleExport}>Export Report</button>
        </div>
      </div>

      <div className="scan-summary-meta">
        <div className={`status-pill ${(scan.status ?? 'COMPLETED').toLowerCase()}`}>{scan.status ?? 'Completed'}</div>
        <div className="scan-meta-text">Scanned {relativeTime(scan.scannedAt)} · {scannedDate}</div>
      </div>

      <div className="severity-summary">
        <span className="badge critical">Critical {scan.summary.critical}</span>
        <span className="badge high">High {scan.summary.high}</span>
        <span className="badge medium">Medium {scan.summary.medium}</span>
        <span className="badge low">Low {scan.summary.low}</span>
      </div>
    </section>
  );
}

export function HealthScoreCard({ scan }: Props) {
  const score = scan.healthScore.overallScore;
  const level = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 60 ? 'Fair' : 'Needs Attention';
  const tier = score >= 90 ? 'good' : score >= 75 ? 'good' : score >= 60 ? 'fair' : 'poor';

  return (
    <section className="health-card sweep-card">
      <div className="section-label-row">
        <h2>Website Health Score</h2>
      </div>

      <div className="health-score-visual">
        <div
          className="score-ring"
          data-tier={tier}
          style={{ ['--score' as string]: `${score}` }}
          aria-label={`Health score ${score} out of 100`}
        >
          <div className="score-ring-inner">
            <div className="score-number">{score}</div>
            <div className="score-status">{level}</div>
          </div>
        </div>

        <div className="health-score-copy">
          <p>
            Your website is {score >= 85 ? 'in good shape!' : score >= 60 ? 'okay, but needs attention.' : 'in need of attention.'}
          </p>
          <small>
            {scan.summary.totalIssues === 0
              ? 'No issues found on this scan.'
              : `We found ${scan.summary.totalIssues} issue${scan.summary.totalIssues === 1 ? '' : 's'} across 7 categories that can be improved.`}
          </small>
        </div>
      </div>
    </section>
  );
}

export function KeyMetrics({ scan }: Props) {
  const isWebsite = scan.scanType === 'WEBSITE';
  const pagesLabel = isWebsite
    ? `${scan.progress?.completedPages ?? scan.pages?.length ?? 0} / ${scan.progress?.discoveredPages ?? scan.pages?.length ?? 0}`
    : '1';
  const pagesSub = isWebsite ? 'pages scanned' : 'page scanned';

  return (
    <div className="key-metrics">
      <div className="metric-card">
        <span className="metric-value">{scan.summary.totalIssues}</span>
        <span className="metric-label">Total Issues</span>
        <span className="metric-sub">
          {scan.summary.critical > 0 || scan.summary.high > 0
            ? `${scan.summary.critical} critical · ${scan.summary.high} high`
            : 'No critical or high issues'}
        </span>
      </div>
      <div className="metric-card">
        <span className="metric-value">{pagesLabel}</span>
        <span className="metric-label">{pagesSub}</span>
        <span className="metric-sub">{isWebsite ? (scan.discoveryMethod ?? 'Automatic discovery') : 'Current page scan'}</span>
      </div>
      <div className="metric-card">
        <span className="metric-value">{relativeTime(scan.scannedAt)}</span>
        <span className="metric-label">Last Scan</span>
        <span className="metric-sub">{scan.status ?? 'Completed'}</span>
      </div>
    </div>
  );
}

interface CategoryProps extends Props {
  onSelectCategory?: (category: IssueCategory) => void;
}

export function CategoryScoreList({ scan, onSelectCategory }: CategoryProps) {
  const entries = Object.entries(scan.healthScore.categories) as [IssueCategory, { score: number; weight: number }][];
  const issueCounts = scan.issuesByCategory ?? {};

  return (
    <section className="category-scores animate-in">
      <div className="section-header-row">
        <h3>Health by Category</h3>
      </div>

      <ul className="category-list">
        {entries.map(([key, data]) => {
          const count = issueCounts[key];
          const content = (
            <>
              <div className="category-label-wrap">
                <span className="category-swatch" data-key={key} />
                <span className="cat-name">{CATEGORY_LABEL[key] ?? key}</span>
                <span className="cat-weight">{data.weight}%</span>
                {typeof count === 'number' && count > 0 && <span className="cat-issue-count">{count}</span>}
              </div>
              <div className="category-progress-wrap">
                <div className="category-progress-track">
                  <span className="category-progress-fill" data-key={key} style={{ width: `${data.score}%` }} />
                </div>
                <span className="cat-score">{data.score}</span>
              </div>
            </>
          );

          return (
            <li key={key} className="category-row">
              {onSelectCategory ? (
                <button type="button" className="category-row-button" onClick={() => onSelectCategory(key)}>
                  {content}
                </button>
              ) : content}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function IssueSummaryCards({ scan }: Props) {
  return (
    <div className="issue-summary-cards">
      <div className="summary-card critical">
        <span className="count">{scan.summary.critical}</span>
        <span className="label">Critical</span>
      </div>
      <div className="summary-card high">
        <span className="count">{scan.summary.high}</span>
        <span className="label">High</span>
      </div>
      <div className="summary-card medium">
        <span className="count">{scan.summary.medium}</span>
        <span className="label">Medium</span>
      </div>
      <div className="summary-card low">
        <span className="count">{scan.summary.low}</span>
        <span className="label">Low</span>
      </div>
    </div>
  );
}
