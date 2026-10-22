import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { MonitoredSiteDetail } from '@origami/contracts';
import {
  ApiRequestError,
  askAboutMonitoringRegression,
  fetchMonitoredSite,
  pauseMonitoredSite,
  resumeMonitoredSite,
  runMonitoredSiteNow,
} from '../api/client';
import { ErrorState, LoadingSkeleton } from '../components/StateViews';
import { AnimatedScoreRing } from '../components/AnimatedScoreRing';
import { SparkleIcon } from '../components/icons';
import { lensEvent } from '../notifications/lens-event';

function scoreTier(score: number): 'good' | 'fair' | 'poor' {
  return score >= 75 ? 'good' : score >= 60 ? 'fair' : 'poor';
}

const EVENT_ICON: Record<string, string> = {
  HEALTH_SCORE_DROP: '🔴',
  NEW_JAVASCRIPT_ERROR: '🔴',
  NEW_NETWORK_ERROR: '🔴',
  ACCESSIBILITY_REGRESSION: '🟠',
  PERFORMANCE_REGRESSION: '🟠',
  RESPONSIVE_REGRESSION: '🟠',
  VISUAL_REGRESSION: '🟣',
};

export function MonitoringDetailPage() {
  const { id } = useParams();
  const [detail, setDetail] = useState<MonitoredSiteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [askLoading, setAskLoading] = useState(false);
  const [askAnswer, setAskAnswer] = useState('');
  const [askError, setAskError] = useState('');

  const load = () => {
    if (!id) return;
    setLoading(true);
    fetchMonitoredSite(id)
      .then((data) => { setDetail(data); setError(null); })
      .catch((err) => setError(err instanceof Error ? err.message : 'Monitored website not found'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [id]);

  if (loading) return <div className="dashboard"><LoadingSkeleton /></div>;
  if (error || !detail) return <div className="dashboard"><ErrorState message={error ?? 'Monitored website not found'} /></div>;

  const { site, currentHealthScore, previousHealthScore, scanHistory, events } = detail;
  const change = currentHealthScore !== undefined && previousHealthScore !== undefined ? currentHealthScore - previousHealthScore : undefined;
  const openEvents = site.lastScanId ? events.filter((e) => e.scanId === site.lastScanId) : [];

  const handleRunNow = async () => {
    setBusy(true);
    try {
      await runMonitoredSiteNow(site.id);
      lensEvent.success('Scan started', { resource: site.name });
      load();
    } catch (err) {
      lensEvent.error(err instanceof ApiRequestError ? err.message : 'Could not start the scan.');
    } finally {
      setBusy(false);
    }
  };

  const handleTogglePause = async () => {
    setBusy(true);
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
      setBusy(false);
    }
  };

  const handleAsk = async () => {
    setAskLoading(true);
    setAskError('');
    setAskAnswer('');
    try {
      const res = await askAboutMonitoringRegression(site.id, 'Why did my website score drop?', { silent: true });
      setAskAnswer(res.answer);
    } catch (err) {
      setAskError(err instanceof ApiRequestError ? err.message : 'Could not get an explanation right now.');
    } finally {
      setAskLoading(false);
    }
  };

  return (
    <div className="dashboard issue-detail-page">
      <header className="issue-header-card">
        <div className="issue-detail-topbar">
          <Link to="/monitoring" className="ghost-button back-link">← Back to Monitoring</Link>
        </div>

        <div className="issue-badge-row">
          <span className={`status-pill ${!site.enabled ? 'cancelled' : site.status === 'REGRESSION' ? 'failed' : site.status === 'FAILED' ? 'failed' : 'completed'}`}>
            {!site.enabled ? 'Paused' : site.status === 'REGRESSION' ? '🔴 Regression Detected' : site.status === 'FAILED' ? 'Scan Failed' : site.status === 'PENDING' ? 'Pending first scan' : '🟢 Healthy'}
          </span>
        </div>

        <h1 className="issue-header-title">{site.name}</h1>
        <p className="issue-header-description">{site.url}</p>

        <div className="issue-meta-row">
          <span className="issue-meta-item">Last scan {site.lastScanAt ? new Date(site.lastScanAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never'}</span>
          <span className="issue-meta-item">Next scan {site.enabled ? new Date(site.nextScanAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'paused'}</span>
        </div>

        <div className="confirm-dialog-actions">
          <button type="button" className="primary-button" disabled={busy} onClick={() => void handleRunNow()}>Run Scan Now</button>
          <button type="button" className="ghost-button" disabled={busy} onClick={() => void handleTogglePause()}>
            {site.enabled ? 'Pause Monitoring' : 'Resume Monitoring'}
          </button>
        </div>
      </header>

      <div className="issue-detail-layout">
        <div className="issue-detail-main">
          <article className="detail-card">
            <h3>Monitoring Overview</h3>
            <div className="monitoring-score-row">
              {currentHealthScore !== undefined && (
                <AnimatedScoreRing score={currentHealthScore} tier={scoreTier(currentHealthScore)} ariaLabel={`Current health score ${currentHealthScore} out of 100`} />
              )}
              <div>
                {previousHealthScore !== undefined && <p className="muted">Previous: {previousHealthScore}</p>}
                {change !== undefined && change !== 0 && (
                  <p className={change < 0 ? 'ai-response-error' : 'ai-response'}>{change < 0 ? '↓' : '↑'} {Math.abs(Math.round(change))} from previous scan</p>
                )}
              </div>
            </div>
          </article>

          {openEvents.length > 0 && (
            <article className="detail-card">
              <h3>Detected Changes</h3>
              <ul className="repro-steps-list">
                {openEvents.map((event) => (
                  <li key={event.id}>
                    {EVENT_ICON[event.eventType] ?? '•'} {event.title}
                    <br />
                    <span className="muted">{event.description}</span>
                  </li>
                ))}
              </ul>
            </article>
          )}

          <article className="detail-card">
            <h3>Scan History</h3>
            {scanHistory.length === 0 ? (
              <p className="muted">No scans yet.</p>
            ) : (
              <div className="record-table-wrap">
                <table className="record-table">
                  <thead><tr><th>Date</th><th>Health Score</th><th>Status</th></tr></thead>
                  <tbody>
                    {scanHistory.map((entry) => (
                      <tr key={entry.scanId}>
                        <td>{new Date(entry.scannedAt).toLocaleDateString(undefined, { month: 'short', day: '2-digit' })}</td>
                        <td>{entry.healthScore ?? '—'}</td>
                        <td>{entry.hasOpenRegression ? '🔴 Regression' : entry.status === 'FAILED' ? 'Failed' : 'OK'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>

          <article className="detail-card">
            <h3>Recent Events</h3>
            {events.length === 0 ? (
              <p className="muted">No monitoring events yet.</p>
            ) : (
              <ul className="repro-steps-list">
                {events.slice(0, 20).map((event) => (
                  <li key={event.id}>
                    <span className="muted">{new Date(event.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    <br />
                    {event.title}
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="detail-card ai-section">
            <div className="ai-section-heading">
              <div>
                <h3><SparkleIcon /> Ask Origami</h3>
                <p className="muted">Get an AI explanation of the most recent detected regression.</p>
              </div>
              <button type="button" className="primary-button" disabled={askLoading} onClick={() => void handleAsk()}>
                {askLoading ? 'Thinking…' : 'Why did my website score drop?'}
              </button>
            </div>
            {askAnswer && <p className="ai-response">{askAnswer}</p>}
            {askError && <p className="ai-response-error">{askError}</p>}
          </article>
        </div>
      </div>
    </div>
  );
}
