import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { CodeTarget, ComponentGenerationJob, ComponentGenerationStatus } from '@origami/contracts';
import { CODE_TARGET_META, cancelComponentJob, deleteComponentJob, fetchComponentJob, retryComponentJob } from '../api/client';
import { CodeViewer } from '../components/CodeViewer';
import { HealthBanner } from '../components/HealthBanner';
import { ErrorState, LoadingSkeleton } from '../components/StateViews';
import {
  CodeBracketIcon,
  EyeIcon,
  ListIcon,
  ImageIcon,
  ExternalLinkIcon,
  RefreshIcon,
  DownloadIcon,
  TrashIcon,
  MonitorIcon,
  TabletIcon,
  SmartphoneIcon,
  ClockIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
  GlobeIcon,
} from '../components/icons';
import { lensEvent } from '../notifications/lens-event';
import { confirm } from '../notifications/confirm';
import { buildZip, downloadBlob } from '../utils/zip';

const IN_PROGRESS = new Set(['QUEUED', 'RUNNING']);
const TARGET_OPTIONS: CodeTarget[] = ['REACT', 'NEXT_JS', 'TAILWIND', 'HTML_CSS'];

const STATUS_META: Record<ComponentGenerationStatus, { label: string; tone: 'ready' | 'processing' | 'pending' | 'failed' | 'inactive'; icon: ComponentType; hint: string }> = {
  QUEUED: { label: 'Queued', tone: 'pending', icon: ClockIcon, hint: 'Waiting to start' },
  RUNNING: { label: 'Generating…', tone: 'processing', icon: ClockIcon, hint: 'In progress' },
  BLOCKED_PRIVACY: { label: 'Blocked', tone: 'failed', icon: AlertTriangleIcon, hint: 'Privacy protection' },
  COMPLETED: { label: 'Completed', tone: 'ready', icon: CheckCircleIcon, hint: 'Ready to use' },
  FAILED: { label: 'Failed', tone: 'failed', icon: AlertTriangleIcon, hint: 'Generation failed' },
  CANCELLED: { label: 'Cancelled', tone: 'inactive', icon: AlertTriangleIcon, hint: 'Stopped by user' },
  TIMED_OUT: { label: 'Timed out', tone: 'failed', icon: AlertTriangleIcon, hint: 'Took too long' },
};

type WorkspaceTab = 'code' | 'preview' | 'details' | 'assets';
type PreviewWidth = 'desktop' | 'tablet' | 'mobile';

const PREVIEW_WIDTHS: Record<PreviewWidth, { icon: ComponentType; label: string }> = {
  desktop: { icon: MonitorIcon, label: 'Desktop' },
  tablet: { icon: TabletIcon, label: 'Tablet' },
  mobile: { icon: SmartphoneIcon, label: 'Mobile' },
};

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
  const [deleting, setDeleting] = useState(false);
  const [retryTarget, setRetryTarget] = useState<CodeTarget>('REACT');
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('code');
  const [previewWidth, setPreviewWidth] = useState<PreviewWidth>('desktop');
  /** Tracks the last-seen job status + this job's own Lens Active card id, so the active->complete morph fires only on a real in-progress -> terminal transition observed during this page visit, never for a job already terminal on first load. No progress field exists for this job type — the card stays indeterminate throughout, never a fabricated percentage. */
  const lastStatusRef = useRef<string | undefined>(undefined);
  const activeEventIdRef = useRef<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!jobId) return;
    if (!silent) setLoading(true);
    try {
      const data = await fetchComponentJob(jobId);
      setJob(data);
      setRetryTarget(data.target);
      setError(null);
      const wasInProgress = lastStatusRef.current !== undefined && IN_PROGRESS.has(lastStatusRef.current);
      const nowInProgress = IN_PROGRESS.has(data.status);
      if (nowInProgress && !activeEventIdRef.current) {
        activeEventIdRef.current = lensEvent.active({ title: 'Generating component', resource: data.sourceUrl, detail: data.target });
      } else if (wasInProgress && !nowInProgress && activeEventIdRef.current) {
        const eventId = activeEventIdRef.current;
        activeEventIdRef.current = null;
        if (data.status === 'COMPLETED') lensEvent.complete(eventId, { type: 'success', title: 'Code generated', resource: data.sourceUrl, detail: data.target });
        else if (data.status === 'FAILED') lensEvent.complete(eventId, { type: 'error', title: "Couldn't generate code", detail: 'Please try again with a larger selection.' });
        else if (data.status === 'CANCELLED') lensEvent.complete(eventId, { type: 'warning', title: 'Code generation cancelled' });
        else if (data.status === 'TIMED_OUT') lensEvent.complete(eventId, { type: 'error', title: 'Code generation timed out' });
        else if (data.status === 'BLOCKED_PRIVACY') {
          lensEvent.complete(eventId, { type: 'warning', title: 'Blocked for privacy', detail: 'This selection contains content that cannot be sent for code generation.' });
        }
      }
      lastStatusRef.current = data.status;
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

  useEffect(() => {
    if (activeTab === 'preview' && !htmlPreview) setActiveTab('code');
  }, [activeTab, htmlPreview]);

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

  const handleRegenerateSameTarget = async () => {
    if (!jobId || retrying) return;
    setRetrying(true);
    try {
      const res = await retryComponentJob(jobId);
      lensEvent.success('Regenerating component…');
      navigate(`/components/${res.jobId}`);
    } catch {
      lensEvent.error('Could not start regeneration.');
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

  const handleDelete = async () => {
    if (!jobId || deleting || !job) return;
    const confirmed = await confirm({
      title: 'Delete component?',
      description: `Delete ${job.result?.componentName ?? 'this component'}? This cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    setDeleting(true);
    try {
      await deleteComponentJob(jobId);
      lensEvent.success('Component deleted successfully.');
      navigate('/components');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete component');
      setDeleting(false);
    }
  };

  const handleDownload = () => {
    if (!job?.result?.files?.length) return;
    const { files, componentName } = job.result;
    if (files.length === 1) {
      downloadBlob(new Blob([files[0].content], { type: 'text/plain' }), files[0].path);
    } else {
      const zip = buildZip(files.map((f) => ({ path: `${componentName}/${f.path}`, content: f.content })));
      downloadBlob(zip, `${componentName}.zip`);
    }
    lensEvent.success('Component downloaded.');
  };

  if (loading) {
    return (
      <div className="dashboard component-detail-page">
        <LoadingSkeleton />
      </div>
    );
  }

  if (error && !job) {
    return (
      <div className="dashboard component-detail-page">
        <ErrorState message={error} onRetry={() => load()} />
        <Link to="/components" className="back-link">← Back to Components</Link>
      </div>
    );
  }

  if (!job) return null;

  const statusMeta = STATUS_META[job.status];
  const StatusIcon = statusMeta.icon;
  const canDownload = job.status === 'COMPLETED' && Boolean(job.result?.files?.length);
  const canRegenerate = !IN_PROGRESS.has(job.status);

  return (
    <div className="dashboard component-detail-page animate-in">
      <Link to="/components" className="back-link">← Back to Components</Link>

      <div className="component-header">
        <div className="component-header-identity">
          <span className="component-header-icon" aria-hidden="true"><CodeBracketIcon /></span>
          <div>
            <div className="page-eyebrow">UI Component</div>
            <h1>{job.result?.componentName ?? (IN_PROGRESS.has(job.status) ? 'Generating component…' : 'Component generation')}</h1>
            <p className="component-header-description">Generated from a screenshot using AI. Production-ready code for your project.</p>
            <div className="detail-tags">
              <a href={job.sourceUrl} target="_blank" rel="noreferrer">{job.sourceUrl}</a>
              <span>· {elapsed} elapsed</span>
            </div>
          </div>
        </div>

        <div className="component-header-actions">
          <button type="button" className="ghost-button" onClick={() => window.open(job.sourceUrl, '_blank', 'noopener,noreferrer')}>
            <ExternalLinkIcon /> View source
          </button>
          <button type="button" className="ghost-button" onClick={() => void handleRegenerateSameTarget()} disabled={!canRegenerate || retrying}>
            <RefreshIcon /> Regenerate
          </button>
          <button type="button" className="ghost-button destructive-ghost-button" onClick={() => void handleDelete()} disabled={deleting}>
            <TrashIcon /> Delete
          </button>
          <button type="button" className="primary-button" onClick={handleDownload} disabled={!canDownload}>
            <DownloadIcon /> Download Component
          </button>
        </div>
      </div>

      {job.status === 'COMPLETED' && job.result && (
        <>
          {!job.aiAvailable && (
            <HealthBanner variant="info">AI was unavailable for part of this generation — result quality may be reduced.</HealthBanner>
          )}
          {job.verification && !job.verification.passed && (
            <HealthBanner variant="warning">
              <span className="component-verification-row">
                <span>Verification found possible issues: {job.verification.issues.join(' · ')}</span>
                <span className="component-verification-timestamp">Verified {relativeTime(job.updatedAt)}</span>
              </span>
            </HealthBanner>
          )}
          {job.verification?.passed && (
            <HealthBanner variant="ok">
              <span className="component-verification-row">
                <span>Passed structural verification (syntax, balance, target match, no leaked secrets).</span>
                <span className="component-verification-timestamp">Verified {relativeTime(job.updatedAt)}</span>
              </span>
            </HealthBanner>
          )}
        </>
      )}

      <div className="repo-summary-grid component-metadata-grid">
        <div className="repo-summary-tile">
          <span className="repo-summary-tile-icon total" aria-hidden="true"><CodeBracketIcon /></span>
          <div>
            <span className="repo-summary-tile-count component-metadata-text">{CODE_TARGET_META[job.target].label}</span>
            <span className="repo-summary-tile-label">Target</span>
            <span className="repo-summary-tile-hint">Generation target</span>
          </div>
        </div>
        <div className="repo-summary-tile">
          <span className="repo-summary-tile-icon processing" aria-hidden="true"><GlobeIcon /></span>
          <div>
            <span className="repo-summary-tile-count component-metadata-text">{hostnameOf(job.sourceUrl)}</span>
            <span className="repo-summary-tile-label">Source</span>
            <span className="repo-summary-tile-hint">Source website</span>
          </div>
        </div>
        <div className="repo-summary-tile">
          <span className="repo-summary-tile-icon processing" aria-hidden="true"><ClockIcon /></span>
          <div>
            <span className="repo-summary-tile-count component-metadata-text">{new Date(job.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
            <span className="repo-summary-tile-label">Generated</span>
            <span className="repo-summary-tile-hint">{elapsed} elapsed</span>
          </div>
        </div>
        <div className="repo-summary-tile">
          <span className={`repo-summary-tile-icon ${statusMeta.tone}`} aria-hidden="true"><StatusIcon /></span>
          <div>
            <span className="repo-summary-tile-count component-metadata-text">{statusMeta.label}</span>
            <span className="repo-summary-tile-label">Status</span>
            <span className="repo-summary-tile-hint">{statusMeta.hint}</span>
          </div>
        </div>
      </div>

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
          <p>{job.error ?? 'The AI generation took longer than the allowed processing window.'}</p>
          <div className="ai-actions">
            <select value={retryTarget} onChange={(e) => setRetryTarget(e.target.value as CodeTarget)}>
              {TARGET_OPTIONS.map((t) => (
                <option key={t} value={t}>{CODE_TARGET_META[t].label}</option>
              ))}
            </select>
            <button type="button" className="primary-button" onClick={handleRetry} disabled={retrying}>
              {retrying ? 'Starting…' : 'Try again'}
            </button>
          </div>
        </section>
      )}

      {job.status === 'BLOCKED_PRIVACY' && (
        <section className="component-status-card blocked">
          <h3>Generation blocked for privacy</h3>
          <p>{job.error ?? 'Sensitive information was detected and the request was not sent for generation.'}</p>
          <p className="muted">Select the extension icon on the page and choose a different area.</p>
        </section>
      )}

      {job.status === 'FAILED' && (
        <section className="component-status-card failed">
          <h3>Component generation failed</h3>
          <p>{job.error ?? 'Origami Lens could not complete this generation.'}</p>
          <div className="ai-actions">
            <select value={retryTarget} onChange={(e) => setRetryTarget(e.target.value as CodeTarget)}>
              {TARGET_OPTIONS.map((t) => (
                <option key={t} value={t}>{CODE_TARGET_META[t].label}</option>
              ))}
            </select>
            <button type="button" className="primary-button" onClick={handleRetry} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Retry generation'}
            </button>
          </div>
        </section>
      )}

      {job.status === 'COMPLETED' && job.result && (
        <>
          {job.result.notes.length > 0 && (
            <ul className="component-notes">
              {job.result.notes.map((note, i) => <li key={i}>{note}</li>)}
            </ul>
          )}

          <div className="workspace-tabs component-workspace-tabs" role="tablist" aria-label="Component workspace">
            <button type="button" role="tab" aria-selected={activeTab === 'code'} className={`workspace-tab ${activeTab === 'code' ? 'active' : ''}`} onClick={() => setActiveTab('code')}>
              <CodeBracketIcon /> Code
            </button>
            {htmlPreview && (
              <button type="button" role="tab" aria-selected={activeTab === 'preview'} className={`workspace-tab ${activeTab === 'preview' ? 'active' : ''}`} onClick={() => setActiveTab('preview')}>
                <EyeIcon /> Preview
              </button>
            )}
            <button type="button" role="tab" aria-selected={activeTab === 'details'} className={`workspace-tab ${activeTab === 'details' ? 'active' : ''}`} onClick={() => setActiveTab('details')}>
              <ListIcon /> Details
            </button>
            <button type="button" role="tab" aria-selected={activeTab === 'assets'} className={`workspace-tab ${activeTab === 'assets' ? 'active' : ''}`} onClick={() => setActiveTab('assets')}>
              <ImageIcon /> Assets
            </button>
          </div>

          {activeTab === 'code' && <CodeViewer componentName={job.result.componentName} files={job.result.files} />}

          {activeTab === 'preview' && htmlPreview && (
            <div className="component-preview-panel">
              <div className="component-preview-toolbar">
                <span className="component-preview-label"><EyeIcon /> Live Preview</span>
                <div className="component-preview-device-switch">
                  {(Object.keys(PREVIEW_WIDTHS) as PreviewWidth[]).map((w) => {
                    const Meta = PREVIEW_WIDTHS[w];
                    const Icon = Meta.icon;
                    return (
                      <button
                        key={w}
                        type="button"
                        className={previewWidth === w ? 'active' : ''}
                        onClick={() => setPreviewWidth(w)}
                        aria-label={Meta.label}
                        title={Meta.label}
                      >
                        <Icon />
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className={`component-preview-frame-wrap ${previewWidth}`}>
                <iframe
                  className="component-preview-frame"
                  title="Component preview"
                  srcDoc={htmlPreview}
                  sandbox="allow-same-origin"
                />
              </div>
            </div>
          )}

          {activeTab === 'details' && (
            <div className="component-details-panel">
              <dl className="component-details-list">
                <div><dt>Component ID</dt><dd className="mono">{job.jobId}</dd></div>
                <div><dt>Target</dt><dd>{CODE_TARGET_META[job.target].label}</dd></div>
                <div><dt>Source</dt><dd><a href={job.sourceUrl} target="_blank" rel="noreferrer">{job.sourceUrl}</a></dd></div>
                {job.pageTitle && <div><dt>Page title</dt><dd>{job.pageTitle}</dd></div>}
                <div><dt>Status</dt><dd>{statusMeta.label}</dd></div>
                <div><dt>Created</dt><dd>{new Date(job.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>
                <div><dt>Updated</dt><dd>{new Date(job.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>
                {job.verification && (
                  <div>
                    <dt>Verification</dt>
                    <dd>{job.verification.passed ? 'Passed' : `Issues found: ${job.verification.issues.join(', ')}`}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}

          {activeTab === 'assets' && (
            <div className="empty-state-card component-assets-empty">
              <span className="empty-state-icon" aria-hidden="true"><ImageIcon /></span>
              <h3>No assets</h3>
              <p>This component does not contain additional assets.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
