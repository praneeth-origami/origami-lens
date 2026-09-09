import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ComponentJobListItem } from '@origami/contracts';
import { CODE_TARGET_META, fetchComponentJobs } from '../api/client';
import { LoadingSkeleton, ErrorState } from '../components/StateViews';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const STATUS_LABEL: Record<string, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Generating',
  COMPLETED: 'Ready',
  FAILED: 'Failed',
  BLOCKED_PRIVACY: 'Blocked',
};

export function ComponentsListPage() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<ComponentJobListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = () => {
    setLoading(true);
    setError(null);
    fetchComponentJobs()
      .then((data) => setJobs(data.jobs))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load components'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((j) => j.sourceUrl.toLowerCase().includes(q) || (j.componentName ?? '').toLowerCase().includes(q));
  }, [jobs, query]);

  return (
    <div className="list-page animate-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">Components</h1>
          <p className="page-subtitle">Every component generated with Screenshot → Code.</p>
        </div>
        {jobs.length > 0 && (
          <input
            type="search"
            className="search-input list-page-search"
            placeholder="Filter by name or website…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter components"
          />
        )}
      </div>

      {loading && <LoadingSkeleton />}
      {!loading && error && <ErrorState message={error} onRetry={load} />}

      {!loading && !error && jobs.length === 0 && (
        <div className="empty-state">
          <p>
            No components generated yet. Select an area on any webpage with the <strong>Screenshot → Code</strong> tool
            in the Origami Lens extension.
          </p>
        </div>
      )}

      {!loading && !error && jobs.length > 0 && (
        <div className="record-table-wrap">
          <table className="record-table">
            <thead>
              <tr>
                <th>Component</th>
                <th>Target</th>
                <th>Status</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((job) => (
                <tr key={job.jobId} onClick={() => navigate(`/components/${job.jobId}`)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/components/${job.jobId}`); }}>
                  <td>
                    <span className="record-primary">{job.componentName ?? 'Generating…'}</span>
                  </td>
                  <td>{CODE_TARGET_META[job.target].label}</td>
                  <td>
                    <span className={`activity-status-dot ${job.status.toLowerCase()}`} aria-hidden="true" />{' '}
                    {STATUS_LABEL[job.status] ?? job.status}
                  </td>
                  <td>
                    <span className="record-secondary">{hostnameOf(job.sourceUrl)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <p className="activity-empty" style={{ padding: 16 }}>No components match "{query}".</p>}
        </div>
      )}
    </div>
  );
}
