import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { MonitoredSiteSummary } from '@origami/contracts';
import {
  ApiRequestError,
  createMonitoredSite,
  fetchMonitoredSites,
  pauseMonitoredSite,
  resumeMonitoredSite,
  runMonitoredSiteNow,
} from '../api/client';
import { ErrorState } from '../components/StateViews';
import { AnimatedScoreRing } from '../components/AnimatedScoreRing';
import { MonitorIcon, AlertTriangleIcon, CheckCircleIcon, ClockIcon } from '../components/icons';
import { lensEvent } from '../notifications/lens-event';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function scoreTier(score: number): 'good' | 'fair' | 'poor' {
  return score >= 75 ? 'good' : score >= 60 ? 'fair' : 'poor';
}

function formatRelative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const minutes = Math.round(ms / 60000);
  if (Math.abs(minutes) < 1) return 'just now';
  const future = minutes > 0;
  const abs = Math.abs(minutes);
  if (abs < 60) return future ? `in ${abs} min` : `${abs} min ago`;
  const hours = Math.round(abs / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

/** "Add Website" — same modal shell (.report-share-overlay/.report-share-dialog) ReportShareModal/CreateGitHubIssueButton already use, never a new dialog pattern. */
function AddWebsiteModal({ onClose, onCreated }: { onClose: () => void; onCreated: (site: MonitoredSiteSummary) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { closeButtonRef.current?.focus(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const site = await createMonitoredSite({ name: name.trim(), url: url.trim(), frequency: 'DAILY', enabled });
      lensEvent.success('Monitoring started', { resource: site.name, icon: <MonitorIcon /> });
      onCreated({ ...site, openRegressionCount: 0 });
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not start monitoring this website.');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="report-share-overlay" onClick={onClose}>
      <div className="report-share-dialog" role="dialog" aria-modal="true" aria-labelledby="add-website-title" onClick={(e) => e.stopPropagation()}>
        <div className="report-share-header">
          <h2 id="add-website-title">Add Website</h2>
          <button type="button" ref={closeButtonRef} className="report-share-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <label className="github-issue-field">
            Website Name
            <input className="search-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Checkout" required />
          </label>
          <label className="github-issue-field">
            Website URL
            <input className="search-input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.customer.com" required />
          </label>
          <label className="github-issue-field">
            Monitoring Frequency
            <select className="search-input" value="DAILY" disabled>
              <option value="DAILY">Daily</option>
            </select>
          </label>
          <label className="monitoring-enable-toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enable Monitoring
          </label>
          {error && <p className="connect-repo-error" role="alert">{error}</p>}
          <div className="confirm-dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="primary-button" disabled={submitting || !name.trim() || !url.trim()}>
              {submitting ? 'Starting…' : 'Start Monitoring'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

export function MonitoringListPage() {
  const navigate = useNavigate();
  const [sites, setSites] = useState<MonitoredSiteSummary[]>([]);
  const [stats, setStats] = useState({ total: 0, healthy: 0, regressions: 0, failed: 0, paused: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<string>(new Date().toISOString());

  const load = () => {
    setLoading(true);
    fetchMonitoredSites()
      .then((res) => {
        setSites(res.sites);
        setStats(res.stats);
        setLastChecked(new Date().toISOString());
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load monitored websites'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleRunNow = async (site: MonitoredSiteSummary) => {
    setBusyId(site.id);
    try {
      await runMonitoredSiteNow(site.id);
      lensEvent.success('Scan started', { resource: site.name });
      load();
    } catch (err) {
      lensEvent.error(err instanceof ApiRequestError ? err.message : 'Could not start the scan.');
    } finally {
      setBusyId(null);
    }
  };

  const handleTogglePause = async (site: MonitoredSiteSummary) => {
    setBusyId(site.id);
    try {
      if (site.enabled) {
        await pauseMonitoredSite(site.id);
        lensEvent.success('Monitoring paused', { resource: site.name });
      } else {
        await resumeMonitoredSite(site.id);
        lensEvent.success('Monitoring resumed', { resource: site.name });
      }
      load();
    } catch (err) {
      lensEvent.error(err instanceof ApiRequestError ? err.message : 'Could not update monitoring.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="list-page animate-in">
      <div className="page-heading-row workspace-heading-row">
        <div>
          <div className="page-eyebrow"><MonitorIcon /> Monitoring</div>
          <h1 className="page-title">Continuous Website Monitoring</h1>
          <p className="page-subtitle">Automatically detect website regressions after deployments.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setAddOpen(true)}>+ Add Website</button>
      </div>

      {loading && (
        <div className="repo-summary-grid">
          {[0, 1, 2, 3].map((i) => <div key={i} className="repo-skeleton-row" />)}
        </div>
      )}

      {!loading && error && <ErrorState message={error} onRetry={load} />}

      {!loading && !error && sites.length === 0 && (
        <div className="empty-state-card">
          <span className="empty-state-icon" aria-hidden="true"><MonitorIcon /></span>
          <h3>No monitored websites yet</h3>
          <p>Add a website to automatically re-scan it every day and get alerted about regressions.</p>
        </div>
      )}

      {!loading && !error && sites.length > 0 && (
        <>
          <div className="repo-summary-row">
            <div className="repo-summary-grid">
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon total" aria-hidden="true"><MonitorIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{stats.total}</span>
                  <span className="repo-summary-tile-label">Monitored Sites</span>
                </div>
              </div>
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon ready" aria-hidden="true"><CheckCircleIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{stats.healthy}</span>
                  <span className="repo-summary-tile-label">Healthy</span>
                </div>
              </div>
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon failed" aria-hidden="true"><AlertTriangleIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{stats.regressions}</span>
                  <span className="repo-summary-tile-label">Regressions</span>
                </div>
              </div>
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon processing" aria-hidden="true"><ClockIcon /></span>
                <div>
                  <span className="repo-summary-tile-count repo-summary-tile-count-small">{formatRelative(lastChecked)}</span>
                  <span className="repo-summary-tile-label">Last checked</span>
                </div>
              </div>
            </div>
          </div>

          <div className="record-table-wrap">
            <table className="record-table repo-table">
              <thead>
                <tr>
                  <th>Website</th>
                  <th>Status</th>
                  <th>Health Score</th>
                  <th>Change</th>
                  <th>Last Scan</th>
                  <th>Next Scan</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => {
                  const change = site.currentHealthScore !== undefined && site.previousHealthScore !== undefined
                    ? site.currentHealthScore - site.previousHealthScore
                    : undefined;
                  const statusLabel = !site.enabled ? 'Paused' : site.status === 'REGRESSION' ? 'Regression' : site.status === 'FAILED' ? 'Failed' : site.status === 'PENDING' ? 'Pending first scan' : 'Healthy';
                  const statusClass = !site.enabled ? 'cancelled' : site.status === 'REGRESSION' ? 'failed' : site.status === 'FAILED' ? 'failed' : site.status === 'PENDING' ? 'queued' : 'completed';
                  return (
                    <tr key={site.id} onClick={() => navigate(`/monitoring/${site.id}`)} tabIndex={0}>
                      <td data-label="Website">
                        <div className="repo-identity">
                          <span className="repo-identity-icon" aria-hidden="true"><MonitorIcon /></span>
                          <div>
                            <span className="record-primary">{site.name}</span>
                            <span className="record-secondary">{hostnameOf(site.url)}</span>
                          </div>
                        </div>
                      </td>
                      <td data-label="Status">
                        <span className={`status-pill ${statusClass}`}>
                          {site.status === 'REGRESSION' && site.enabled ? '🔴 ' : site.status === 'HEALTHY' && site.enabled ? '🟢 ' : ''}
                          {statusLabel}
                        </span>
                      </td>
                      <td data-label="Health Score">
                        {site.currentHealthScore !== undefined ? (
                          <AnimatedScoreRing score={site.currentHealthScore} tier={scoreTier(site.currentHealthScore)} small ariaLabel={`Health score ${site.currentHealthScore} out of 100`} />
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td data-label="Change">
                        {change !== undefined && change !== 0 ? (
                          <span className={change < 0 ? 'record-secondary negative' : 'record-secondary positive'}>
                            {change < 0 ? '↓' : '↑'} {Math.abs(Math.round(change))}
                          </span>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td data-label="Last Scan">{site.lastScanAt ? new Date(site.lastScanAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td>
                      <td data-label="Next Scan">{site.enabled ? new Date(site.nextScanAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Paused'}</td>
                      <td data-label="Actions" className="repo-actions-cell" onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="ghost-button" disabled={busyId === site.id} onClick={() => void handleRunNow(site)}>Run Now</button>
                        <button type="button" className="ghost-button" disabled={busyId === site.id} onClick={() => void handleTogglePause(site)}>
                          {site.enabled ? 'Pause' : 'Resume'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {addOpen && (
        <AddWebsiteModal
          onClose={() => setAddOpen(false)}
          onCreated={() => load()}
        />
      )}
    </div>
  );
}
