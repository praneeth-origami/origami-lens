import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { CodeTarget, ComponentGenerationJob } from '@origami/contracts';
import { CODE_TARGET_META, cancelComponentJob, fetchComponentJob, retryComponentJob } from '../api/client';
import { CodeViewer } from '../components/CodeViewer';
import { HealthBanner } from '../components/HealthBanner';
import { ErrorState, LoadingSkeleton } from '../components/StateViews';

const IN_PROGRESS = new Set(['QUEUED', 'RUNNING']);
const TARGET_OPTIONS: CodeTarget[] = ['REACT', 'NEXT_JS', 'TAILWIND', 'HTML_CSS'];

function buildHtmlPreviewSrcdoc(job: ComponentGenerationJob): string | null {
  if (job.target !== 'HTML_CSS' || !job.result) return null;
  const html = job.result.files.find((f) => f.path.endsWith('.html'))?.content;
  const css = job.result.files.find((f) => f.path.endsWith('.css'))?.content ?? '';
  if (!html) return null;
  if (/<html[\s>]/i.test(html)) return html;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`;
}

export function ComponentDetailPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState<ComponentGenerationJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retryTarget, setRetryTarget] = useState<CodeTarget>('REACT');
  const [previewMode, setPreviewMode] = useState<'code' | 'preview'>('code');

  const load = useCallback(async (silent = false) => {
    if (!jobId) return;
    if (!silent) setLoading(true);
    try {
      const data = await fetchComponentJob(jobId);
      setJob(data);
      setRetryTarget(data.target);
      setError(null);
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : 'Failed to load generation job');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!job || !IN_PROGRESS.has(job.status)) return;
    const id = setInterval(() => load(true), 2000);
    return () => clearInterval(id);
  }, [job, load]);

  const elapsed = useMemo(() => {
    if (!job) return '';
    const ms = Date.now() - new Date(job.createdAt).getTime();
    const seconds = Math.max(0, Math.round(ms / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
  }, [job]);

  const htmlPreview = job ? buildHtmlPreviewSrcdoc(job) : null;

  const handleRetry = async () => {
    if (!jobId) return;
    setRetrying(true);
    try {
      const res = await retryComponentJob(jobId, retryTarget);
      navigate(`/components/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetrying(false);
    }
  };

  const handleCancel = async () => {
    if (!jobId || cancelling) return;
    setCancelling(true);
    try {
      // The backend is the source of truth for the resulting status — a job
      // that finished a split second before this request arrived stays
      // COMPLETED/FAILED rather than being overwritten, so re-fetch the full
      // record (including the error message) rather than assuming CANCELLED.
      const res = await cancelComponentJob(jobId);
      setJob((prev) => (prev ? { ...prev, status: res.status as ComponentGenerationJob['status'] } : prev));
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop generation');
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
    return (
      <div className="dashboard">
        <LoadingSkeleton />
      </div>
    );
  }

  if (error && !job) {
    return (
      <div className="dashboard">
        <ErrorState message={error} onRetry={() => load()} />
        <Link to="/" className="back-link">← Back to Dashboard</Link>
      </div>
    );
  }

  if (!job) return null;

  return (
    <div className="dashboard component-detail-page">
      <Link to="/" className="back-link">← Back to Dashboard</Link>

      <header className="issue-detail-header">
        <span className="category-pill">{CODE_TARGET_META[job.target].label}</span>
        <h1>{job.result?.componentName ?? (IN_PROGRESS.has(job.status) ? 'Generating component…' : 'Component generation')}</h1>
        <div className="detail-tags">
          <a href={job.sourceUrl} target="_blank" rel="noreferrer">{job.sourceUrl}</a>
          <span>{elapsed} elapsed</span>
        </div>
      </header>

      {IN_PROGRESS.has(job.status) && (
        <section className="component-status-card">
          <div className="spinner-inline" aria-hidden="true" />
          <p>{job.status === 'QUEUED' ? 'Queued for generation…' : 'Analyzing the screenshot and generating your component…'}</p>
          <p className="muted">This continues even if you close this tab — check back any time at this link.</p>
          <button type="button" className="btn-secondary stop-generation-button" onClick={handleCancel} disabled={cancelling}>
            {cancelling ? 'Stopping…' : 'Stop Generation'}
          </button>
        </section>
      )}

      {job.status === 'CANCELLED' && (
        <section className="component-status-card cancelled">
          <h3>Generation cancelled</h3>
          <p>{job.error ?? 'Generation cancelled by user.'}</p>
          <div className="ai-actions">
            <select value={retryTarget} onChange={(e) => setRetryTarget(e.target.value as CodeTarget)}>
              {TARGET_OPTIONS.map((t) => (
                <option key={t} value={t}>{CODE_TARGET_META[t].label}</option>
              ))}
            </select>
            <button type="button" className="primary-button" onClick={handleRetry} disabled={retrying}>
              {retrying ? 'Starting…' : 'Generate Again'}
            </button>
          </div>
        </section>
      )}

      {job.status === 'TIMED_OUT' && (
        <section className="component-status-card timed-out">
          <h3>Generation timed out</h3>
          <p>{job.error ?? 'Generation timed out. Please try again.'}</p>
          <div className="ai-actions">
            <select value={retryTarget} onChange={(e) => setRetryTarget(e.target.value as CodeTarget)}>
              {TARGET_OPTIONS.map((t) => (
                <option key={t} value={t}>{CODE_TARGET_META[t].label}</option>
              ))}
            </select>
            <button type="button" className="primary-button" onClick={handleRetry} disabled={retrying}>
              {retrying ? 'Starting…' : 'Retry'}
            </button>
          </div>
        </section>
      )}

      {job.status === 'BLOCKED_PRIVACY' && (
        <section className="component-status-card blocked">
          <h3>Blocked for your privacy</h3>
          <p>{job.error}</p>
          <p className="muted">Select the extension icon on the page and choose a different area.</p>
        </section>
      )}

      {job.status === 'FAILED' && (
        <section className="component-status-card failed">
          <h3>Code generation failed</h3>
          <p>{job.error}</p>
          <div className="ai-actions">
            <select value={retryTarget} onChange={(e) => setRetryTarget(e.target.value as CodeTarget)}>
              {TARGET_OPTIONS.map((t) => (
                <option key={t} value={t}>{CODE_TARGET_META[t].label}</option>
              ))}
            </select>
            <button type="button" className="primary-button" onClick={handleRetry} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        </section>
      )}

      {job.status === 'COMPLETED' && job.result && (
        <>
          {!job.aiAvailable && (
            <HealthBanner variant="info">AI was unavailable for part of this generation — result quality may be reduced.</HealthBanner>
          )}

          {job.verification && !job.verification.passed && (
            <HealthBanner variant="warning">
              Verification found possible issues: {job.verification.issues.join(' · ')}
            </HealthBanner>
          )}
          {job.verification?.passed && (
            <HealthBanner variant="ok">Passed structural verification (syntax, balance, target match, no leaked secrets).</HealthBanner>
          )}

          {job.result.notes.length > 0 && (
            <ul className="component-notes">
              {job.result.notes.map((note, i) => <li key={i}>{note}</li>)}
            </ul>
          )}

          {htmlPreview && (
            <div className="view-toggle">
              <button type="button" className={previewMode === 'code' ? 'active' : ''} onClick={() => setPreviewMode('code')}>Code</button>
              <button type="button" className={previewMode === 'preview' ? 'active' : ''} onClick={() => setPreviewMode('preview')}>Preview</button>
            </div>
          )}

          {previewMode === 'preview' && htmlPreview ? (
            <iframe
              className="component-preview-frame"
              title="Component preview"
              srcDoc={htmlPreview}
              sandbox="allow-same-origin"
            />
          ) : (
            <CodeViewer componentName={job.result.componentName} files={job.result.files} />
          )}

          <div className="ai-actions" style={{ marginTop: 16 }}>
            <select value={retryTarget} onChange={(e) => setRetryTarget(e.target.value as CodeTarget)}>
              {TARGET_OPTIONS.map((t) => (
                <option key={t} value={t}>{CODE_TARGET_META[t].label}</option>
              ))}
            </select>
            <button type="button" className="ghost-button" onClick={handleRetry} disabled={retrying}>
              {retrying ? 'Generating…' : 'Generate another target'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
