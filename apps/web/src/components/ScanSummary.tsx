import { Link } from 'react-router-dom';
import type { IssueCategory, ScanListItem, ScanResponse } from '@origami/contracts';
import { CATEGORY_LABEL } from '../api/client';
import { ReportExportMenu } from './ReportExportMenu';
import { ReportShareButton } from './ReportShareModal';
import { AnimatedScoreRing } from './AnimatedScoreRing';
import { AnimatedProgressBar } from './AnimatedProgressBar';

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

const REPORT_READY_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_WARNINGS']);

export function ScanSummary({ scan, scans, activeScanId, onSelectScan }: ScanSummaryProps) {
  const host = hostnameOf(scan.url);
  const reportReady = REPORT_READY_STATUSES.has(scan.status ?? 'COMPLETED');
  const disabledReason = reportReady ? undefined : 'This scan has not completed successfully yet, so it has no report to share or export.';

  const scannedDate = new Date(scan.scannedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <section className="scan-summary animate-in">
      <Link to="/scans" className="back-link">← Back to Scans</Link>

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
          <ReportShareButton scanId={scan.scanId} disabled={!reportReady} disabledReason={disabledReason} />
          <ReportExportMenu scanId={scan.scanId} disabled={!reportReady} disabledReason={disabledReason} />
        </div>
      </div>

      <div className="scan-summary-meta">
        <div className={`status-pill ${(scan.status ?? 'COMPLETED').toLowerCase()}`}>{scan.status ?? 'Completed'}</div>
        <div className="scan-meta-text">Scanned {relativeTime(scan.scannedAt)} · {scannedDate}</div>
      </div>
    </section>
  );
}

export function HealthScoreCard({ scan }: Props) {
  const score = scan.healthScore.overallScore;
  const level = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 60 ? 'Fair' : 'Needs Attention';
  const tier = score >= 90 ? 'good' : score >= 75 ? 'good' : score >= 60 ? 'fair' : 'poor';

  return <AnimatedScoreRing score={score} tier={tier} statusLabel={level} ariaLabel={`Health score ${score} out of 100, ${level}`} />;
}

/**
 * The single consolidated "what's the state of this scan" strip — health
 * score, the same critical/high/medium/low counts previously repeated in
 * three separate places on this page (ScanSummary's badge row, this, and
 * the Issues section's own summary cards), plus the couple of scan-identity
 * facts (pages scanned, last-scan time) that used to be their own 3 large
 * metric cards. All real values already computed server-side — nothing
 * calculated here, just presented once instead of three times.
 */
export function HealthSummary({ scan }: Props) {
  const isWebsite = scan.scanType === 'WEBSITE';
  const pagesLabel = isWebsite
    ? `${scan.progress?.completedPages ?? scan.pages?.length ?? 0}/${scan.progress?.discoveredPages ?? scan.pages?.length ?? 0} pages scanned`
    : '1 page scanned';

  return (
    <section className="health-summary animate-in">
      <HealthScoreCard scan={scan} />

      <div className="health-summary-side">
        <IssueSummaryCards scan={scan} />
        <div className="health-summary-meta">
          <span>{pagesLabel}</span>
          <span aria-hidden="true">·</span>
          <span>Last scan {relativeTime(scan.scannedAt)}</span>
        </div>
      </div>
    </section>
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
                <AnimatedProgressBar
                  percent={data.score}
                  dataKey={key}
                  trackClassName="category-progress-track"
                  fillClassName="category-progress-fill"
                />
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
