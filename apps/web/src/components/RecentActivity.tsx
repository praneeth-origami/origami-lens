import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ComponentJobListItem, ScanListItem } from '@origami/contracts';
import { CODE_TARGET_META, fetchComponentJobs } from '../api/client';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

interface ScansProps {
  scans: ScanListItem[];
  activeScanId?: string;
  onSelect: (scanId: string) => void;
}

function RecentScansCard({ scans, activeScanId, onSelect }: ScansProps) {
  const recent = scans.slice(0, 5);

  return (
    <section className="activity-card">
      <div className="section-header-row">
        <h3>Recent Scans</h3>
        <Link to="/scans" className="table-link">View all →</Link>
      </div>

      {recent.length === 0 ? (
        <p className="activity-empty">No scans yet.</p>
      ) : (
        <ul className="activity-list">
          {recent.map((scan) => (
            <li key={scan.scanId} className={scan.scanId === activeScanId ? 'active' : ''}>
              <button type="button" onClick={() => onSelect(scan.scanId)}>
                <div className="activity-item-main">
                  <span className="activity-item-title">{hostnameOf(scan.url)}</span>
                  <span className="activity-item-meta">
                    {scan.scanType === 'WEBSITE' ? 'Website scan' : 'Page scan'} ·{' '}
                    {new Date(scan.scannedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                </div>
                <div className="activity-item-score" data-tier={scan.overallScore >= 90 ? 'good' : scan.overallScore >= 70 ? 'fair' : 'poor'}>
                  {scan.overallScore}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentComponentsCard() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<ComponentJobListItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchComponentJobs()
      .then((data) => setJobs(data.jobs))
      .catch(() => setJobs([]))
      .finally(() => setLoaded(true));
  }, []);

  if (loaded && jobs.length === 0) return null;

  const recent = jobs.slice(0, 5);

  return (
    <section className="activity-card">
      <div className="section-header-row">
        <h3>Recent Components</h3>
        <Link to="/components" className="table-link">View all →</Link>
      </div>

      {recent.length === 0 ? (
        <p className="activity-empty">No components generated yet.</p>
      ) : (
        <ul className="activity-list">
          {recent.map((job) => (
            <li key={job.jobId}>
              <button type="button" onClick={() => navigate(`/components/${job.jobId}`)}>
                <div className="activity-item-main">
                  <span className="activity-item-title">{job.componentName ?? hostnameOf(job.sourceUrl)}</span>
                  <span className="activity-item-meta">{CODE_TARGET_META[job.target].label} · {hostnameOf(job.sourceUrl)}</span>
                </div>
                <span className={`activity-status-dot ${job.status.toLowerCase()}`} aria-label={job.status} title={job.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function RecentActivity({ scans, activeScanId, onSelect }: ScansProps) {
  return (
    <div className="recent-activity-grid">
      <RecentScansCard scans={scans} activeScanId={activeScanId} onSelect={onSelect} />
      <RecentComponentsCard />
    </div>
  );
}
