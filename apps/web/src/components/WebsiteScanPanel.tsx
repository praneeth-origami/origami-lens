import { Link } from 'react-router-dom';
import type { PageScanRecord, ScanResponse } from '@origami/contracts';

interface Props {
  scan: ScanResponse;
}

export function WebsiteScanPanel({ scan }: Props) {
  if (scan.scanType !== 'WEBSITE') return null;

  const progress = scan.progress ?? {
    discoveredPages: scan.pages?.length ?? 0,
    completedPages: scan.pages?.filter((p) => p.status === 'COMPLETED').length ?? 0,
    failedPages: scan.failedPages?.length ?? 0,
    issuesFound: scan.summary.totalIssues,
  };

  return (
    <section className="website-scan-panel">
      <div className="scan-type-badge">Website Scan</div>
      <div className="website-meta">
        <div>
          <span className="label">Root URL</span>
          <a href={scan.url} target="_blank" rel="noreferrer" className="value link">{scan.url}</a>
        </div>
        <div>
          <span className="label">Status</span>
          <span className="value">{scan.status ?? 'COMPLETED'}</span>
        </div>
        {scan.discoveryMethod && (
          <div>
            <span className="label">Discovery</span>
            <span className="value">{scan.discoveryMethod}</span>
          </div>
        )}
        <div>
          <span className="label">Progress</span>
          <span className="value">
            {progress.completedPages} / {progress.discoveredPages} scanned
            {progress.failedPages > 0 && ` · ${progress.failedPages} failed`}
          </span>
        </div>
      </div>
      {scan.error && <p className="scan-error">{scan.error}</p>}
    </section>
  );
}

interface PagesTableProps {
  scanId: string;
  pages?: PageScanRecord[];
}

export function PagesTable({ scanId, pages }: PagesTableProps) {
  if (!pages || pages.length === 0) return null;

  return (
    <section className="pages-table-section">
      <h3>Pages</h3>
      <div className="pages-table-scroll">
        <table className="pages-table">
          <thead>
            <tr>
              <th>URL</th>
              <th>Status</th>
              <th>Score</th>
              <th>Issues</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((page) => (
              <tr key={page.pageScanId} className={page.status === 'FAILED' ? 'row-failed' : ''}>
                <td>
                  <a href={page.url} target="_blank" rel="noreferrer">{page.url}</a>
                </td>
                <td>{page.status}</td>
                <td>{page.healthScore?.overallScore ?? '—'}</td>
                <td>
                  <Link to={`/scans/${scanId}/pages/${page.pageScanId}`}>
                    {page.issueCount ?? 'View'}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
