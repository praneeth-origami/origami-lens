import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Issue, PageScanRecord } from '@origami/contracts';
import { fetchPageScanDetail } from '../api/client';
import { ErrorState, LoadingSkeleton } from '../components/StateViews';
import { IssueList } from '../components/IssueList';

export function PageScanDetailPage() {
  const { scanId, pageScanId } = useParams();
  const [page, setPage] = useState<PageScanRecord | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!scanId || !pageScanId) return;
    setLoading(true);
    fetchPageScanDetail(scanId, pageScanId)
      .then((data) => {
        setPage(data.page);
        setIssues(data.issues);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load page'))
      .finally(() => setLoading(false));
  }, [scanId, pageScanId]);

  if (loading) {
    return (
      <div className="dashboard">
        <LoadingSkeleton />
      </div>
    );
  }

  if (error || !page) {
    return (
      <div className="dashboard">
        <ErrorState message={error ?? 'Page not found'} />
        <Link to={`/scans/${scanId}`} className="back-link">← Back to scan</Link>
      </div>
    );
  }

  return (
    <div className="dashboard page-scan-detail">
      <Link to={`/scans/${scanId}`} className="back-link">← Back to Website Scan</Link>
      <header className="issue-detail-header">
        <h1>Page Scan</h1>
        <div className="detail-tags">
          <a href={page.url} target="_blank" rel="noreferrer">{page.url}</a>
          <span>{page.status}</span>
          {page.healthScore && <span>Score: {page.healthScore.overallScore}</span>}
        </div>
        {page.error && <p className="scan-error">{page.error}</p>}
      </header>
      <IssueList issues={issues} />
    </div>
  );
}
