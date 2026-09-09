import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ScanListItem } from '@origami/contracts';
import { fetchScans } from '../api/client';
import { LoadingSkeleton, ErrorState } from '../components/StateViews';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function ScansListPage() {
  const navigate = useNavigate();
  const [scans, setScans] = useState<ScanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = () => {
    setLoading(true);
    setError(null);
    fetchScans()
      .then((data) => setScans(data.scans))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load scans'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scans;
    return scans.filter((s) => s.url.toLowerCase().includes(q));
  }, [scans, query]);

  return (
    <div className="list-page animate-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">Scans</h1>
          <p className="page-subtitle">Every Current Page and Entire Website scan Origami Lens has run.</p>
        </div>
        {scans.length > 0 && (
          <input
            type="search"
            className="search-input list-page-search"
            placeholder="Filter by website…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter scans by website"
          />
        )}
      </div>

      {loading && <LoadingSkeleton />}
      {!loading && error && <ErrorState message={error} onRetry={load} />}

      {!loading && !error && scans.length === 0 && (
        <div className="empty-state">
          <p>No scans yet. Run one from the Origami Lens Chrome extension.</p>
        </div>
      )}

      {!loading && !error && scans.length > 0 && (
        <div className="record-table-wrap">
          <table className="record-table">
            <thead>
              <tr>
                <th>Website</th>
                <th>Type</th>
                <th>Health</th>
                <th>Issues</th>
                <th>Scanned</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((scan) => (
                <tr key={scan.scanId} onClick={() => navigate(`/scans/${scan.scanId}`)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/scans/${scan.scanId}`); }}>
                  <td>
                    <span className="record-primary">{hostnameOf(scan.url)}</span>
                    <span className="record-secondary">{scan.url}</span>
                  </td>
                  <td>{scan.scanType === 'WEBSITE' ? 'Entire Website' : 'Current Page'}</td>
                  <td>
                    <span className="score-chip" data-tier={scan.overallScore >= 90 ? 'good' : scan.overallScore >= 70 ? 'fair' : 'poor'}>
                      {scan.overallScore}
                    </span>
                  </td>
                  <td>{scan.totalIssues}</td>
                  <td>{new Date(scan.scannedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <p className="activity-empty" style={{ padding: 16 }}>No scans match "{query}".</p>}
        </div>
      )}
    </div>
  );
}
