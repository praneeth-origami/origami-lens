import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { CodeTarget, ComponentGenerationStatus, ComponentJobListItem } from '@origami/contracts';
import { CODE_TARGET_META, deleteComponentJob, fetchComponentJob, fetchComponentJobs, retryComponentJob } from '../api/client';
import { ErrorState } from '../components/StateViews';
import { CubeIcon, CheckCircleIcon, ClockIcon, AlertTriangleIcon, CodeBracketIcon, MoreIcon } from '../components/icons';
import { lensEvent } from '../notifications/lens-event';
import { confirm } from '../notifications/confirm';
import { buildZip, downloadBlob } from '../utils/zip';

const TARGETS: CodeTarget[] = ['HTML_CSS', 'REACT', 'TAILWIND', 'NEXT_JS'];

const STATUS_META: Record<ComponentGenerationStatus, { label: string; tone: 'ready' | 'processing' | 'pending' | 'failed' | 'inactive' }> = {
  QUEUED: { label: 'Queued', tone: 'pending' },
  RUNNING: { label: 'Generating…', tone: 'processing' },
  BLOCKED_PRIVACY: { label: 'Blocked', tone: 'failed' },
  COMPLETED: { label: 'Ready', tone: 'ready' },
  FAILED: { label: 'Failed', tone: 'failed' },
  CANCELLED: { label: 'Cancelled', tone: 'inactive' },
  TIMED_OUT: { label: 'Timed out', tone: 'failed' },
};

const GENERATING_STATUSES = new Set<ComponentGenerationStatus>(['QUEUED', 'RUNNING']);
const NON_SUCCESS_TERMINAL = new Set<ComponentGenerationStatus>(['FAILED', 'CANCELLED', 'TIMED_OUT', 'BLOCKED_PRIVACY']);
const RETRYABLE_STATUSES = new Set<ComponentGenerationStatus>(['FAILED', 'CANCELLED', 'TIMED_OUT', 'COMPLETED']);

type ComponentTab = 'all' | CodeTarget;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

interface ActionItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/** Generic portal-based "•••" menu — same pattern as ScansListPage.tsx's RowActionsMenu, needed for the same reason: rows sit inside `.animate-in`, which traps position:fixed descendants unless portaled to document.body. */
function RowActionsMenu({ items, ariaLabel, busy }: { items: ActionItem[]; ariaLabel: string; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const updatePosition = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    };
    updatePosition();
    const handleLayoutChange = () => setOpen(false);
    window.addEventListener('scroll', handleLayoutChange, true);
    window.addEventListener('resize', handleLayoutChange);
    return () => {
      window.removeEventListener('scroll', handleLayoutChange, true);
      window.removeEventListener('resize', handleLayoutChange);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="repo-actions-menu-container" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="repo-actions-trigger"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <MoreIcon />
      </button>

      {open && position &&
        createPortal(
          <div ref={menuRef} className="repo-actions-menu" role="menu" aria-label={ariaLabel} style={{ position: 'fixed', top: position.top, right: position.right }}>
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={`repo-actions-menu-item ${item.destructive ? 'destructive' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function ComponentsListPage() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<ComponentJobListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tab, setTab] = useState<ComponentTab>('all');

  const load = () => {
    setLoading(true);
    setError(null);
    fetchComponentJobs()
      .then((data) => setJobs(data.jobs))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load components'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const summary = useMemo(() => {
    let completed = 0;
    let generating = 0;
    let failed = 0;
    for (const job of jobs) {
      if (job.status === 'COMPLETED') completed += 1;
      else if (GENERATING_STATUSES.has(job.status)) generating += 1;
      else if (NON_SUCCESS_TERMINAL.has(job.status)) failed += 1;
    }
    return { total: jobs.length, completed, generating, failed };
  }, [jobs]);

  const tabCounts = useMemo(() => {
    const counts: Record<ComponentTab, number> = { all: jobs.length, HTML_CSS: 0, REACT: 0, TAILWIND: 0, NEXT_JS: 0 };
    for (const job of jobs) counts[job.target] += 1;
    return counts;
  }, [jobs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (tab !== 'all' && job.target !== tab) return false;
      if (!q) return true;
      return (
        (job.componentName ?? '').toLowerCase().includes(q) ||
        job.sourceUrl.toLowerCase().includes(q) ||
        hostnameOf(job.sourceUrl).toLowerCase().includes(q)
      );
    });
  }, [jobs, query, tab]);

  const handleDelete = async (job: ComponentJobListItem) => {
    if (deletingId) return;
    const confirmed = await confirm({
      title: 'Delete component?',
      description: `Delete ${job.componentName ?? 'this component'}? This cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;

    setDeletingId(job.jobId);
    try {
      await deleteComponentJob(job.jobId);
      setJobs((prev) => prev.filter((j) => j.jobId !== job.jobId));
      lensEvent.success('Component deleted successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete component');
    } finally {
      setDeletingId(null);
    }
  };

  const handleRegenerate = async (job: ComponentJobListItem) => {
    setBusyId(job.jobId);
    try {
      await retryComponentJob(job.jobId);
      lensEvent.success('Regenerating component…', { resource: job.componentName ?? hostnameOf(job.sourceUrl) });
      load();
    } catch {
      lensEvent.error('Could not start regeneration.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDownload = async (job: ComponentJobListItem) => {
    setBusyId(job.jobId);
    try {
      const full = await fetchComponentJob(job.jobId);
      const files = full.result?.files ?? [];
      if (files.length === 0) {
        lensEvent.error('No generated files to download.');
        return;
      }
      const name = full.result?.componentName ?? job.componentName ?? 'component';
      if (files.length === 1) {
        downloadBlob(new Blob([files[0].content], { type: 'text/plain' }), files[0].path);
      } else {
        const zip = buildZip(files.map((f) => ({ path: `${name}/${f.path}`, content: f.content })));
        downloadBlob(zip, `${name}.zip`);
      }
      lensEvent.success('Component downloaded.');
    } catch {
      lensEvent.error('Could not download the component.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="list-page animate-in">
      <div className="page-heading-row workspace-heading-row">
        <div>
          <div className="page-eyebrow"><CubeIcon /> Components</div>
          <h1 className="page-title">UI Components</h1>
          <p className="page-subtitle">Every component generated with Screenshot → Code.</p>
        </div>
        <div className="workspace-header-card">
          <span className="workspace-header-card-icon" aria-hidden="true"><CodeBracketIcon /></span>
          <div>
            <div className="workspace-header-card-title">CAPTURE. CONVERT. REUSE.</div>
            <div className="workspace-header-card-subtitle">Turn screenshots into clean, production-ready code components.</div>
          </div>
        </div>
      </div>

      {loading && (
        <>
          <div className="repo-summary-grid">
            {[0, 1, 2, 3].map((i) => <div key={i} className="repo-skeleton-row" />)}
          </div>
          <div className="repo-skeleton-table">
            {[0, 1, 2].map((i) => <div key={i} className="repo-skeleton-row" />)}
          </div>
        </>
      )}

      {!loading && error && <ErrorState message={error} onRetry={load} />}

      {!loading && !error && jobs.length === 0 && (
        <div className="empty-state-card">
          <span className="empty-state-icon" aria-hidden="true"><CubeIcon /></span>
          <h3>No components yet</h3>
          <p>
            Select an area on any webpage with the <strong>Screenshot → Code</strong> tool in the Origami Lens extension
            to generate your first component.
          </p>
        </div>
      )}

      {!loading && !error && jobs.length > 0 && (
        <>
          <div className="repo-summary-row">
            <div className="repo-summary-grid">
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon total" aria-hidden="true"><CubeIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{summary.total}</span>
                  <span className="repo-summary-tile-label">Total components</span>
                  <span className="repo-summary-tile-hint">All time</span>
                </div>
              </div>
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon ready" aria-hidden="true"><CheckCircleIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{summary.completed}</span>
                  <span className="repo-summary-tile-label">Completed</span>
                  <span className="repo-summary-tile-hint">Ready to use</span>
                </div>
              </div>
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon processing" aria-hidden="true"><ClockIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{summary.generating}</span>
                  <span className="repo-summary-tile-label">Generating</span>
                  <span className="repo-summary-tile-hint">In progress</span>
                </div>
              </div>
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon failed" aria-hidden="true"><AlertTriangleIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{summary.failed}</span>
                  <span className="repo-summary-tile-label">Failed</span>
                  <span className="repo-summary-tile-hint">Needs attention</span>
                </div>
              </div>
            </div>
          </div>

          <div className="workspace-toolbar">
            <div className="workspace-tabs" role="tablist" aria-label="Component target">
              <button type="button" role="tab" aria-selected={tab === 'all'} className={`workspace-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
                <CubeIcon /> All components <span className="workspace-tab-count">{tabCounts.all}</span>
              </button>
              {TARGETS.map((target) => (
                <button
                  key={target}
                  type="button"
                  role="tab"
                  aria-selected={tab === target}
                  className={`workspace-tab ${tab === target ? 'active' : ''}`}
                  onClick={() => setTab(target)}
                >
                  <CodeBracketIcon /> {CODE_TARGET_META[target].label} <span className="workspace-tab-count">{tabCounts[target]}</span>
                </button>
              ))}
            </div>
            <div className="list-page-search repo-summary-search">
              <input
                type="search"
                className="search-input"
                placeholder="Filter by name or website…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Filter components by name or website"
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state-card">
              <span className="empty-state-icon" aria-hidden="true"><CodeBracketIcon /></span>
              <h3>No components match your filters</h3>
              <p>Try a different name or website, or switch to a different target.</p>
            </div>
          ) : (
            <div className="record-table-wrap">
              <table className="record-table repo-table">
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>Target</th>
                    <th>Status</th>
                    <th>Source</th>
                    <th>Generated at</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((job) => {
                    const statusMeta = STATUS_META[job.status];
                    const items: ActionItem[] = [
                      { label: 'View component', onClick: () => navigate(`/components/${job.jobId}`) },
                      {
                        label: 'Regenerate',
                        disabled: !RETRYABLE_STATUSES.has(job.status) || busyId === job.jobId,
                        onClick: () => void handleRegenerate(job),
                      },
                      {
                        label: 'Download code',
                        disabled: job.status !== 'COMPLETED' || busyId === job.jobId,
                        onClick: () => void handleDownload(job),
                      },
                      { label: 'Delete component', destructive: true, disabled: deletingId === job.jobId, onClick: () => void handleDelete(job) },
                    ];
                    return (
                      <tr
                        key={job.jobId}
                        onClick={() => navigate(`/components/${job.jobId}`)}
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) navigate(`/components/${job.jobId}`); }}
                      >
                        <td data-label="Component">
                          <div className="repo-identity">
                            <span className="repo-identity-icon" aria-hidden="true"><CodeBracketIcon /></span>
                            <span className="record-primary">{job.componentName ?? 'Generating…'}</span>
                          </div>
                        </td>
                        <td data-label="Target">
                          <span className="repo-provider-cell"><CodeBracketIcon /> {CODE_TARGET_META[job.target].label}</span>
                        </td>
                        <td data-label="Status">
                          <span className={`repo-status-pill ${statusMeta.tone}`}>
                            <span className="repo-status-dot" aria-hidden="true" />
                            {statusMeta.label}
                          </span>
                        </td>
                        <td data-label="Source">{hostnameOf(job.sourceUrl)}</td>
                        <td data-label="Generated at">{new Date(job.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                        <td data-label="Actions" className="repo-actions-cell">
                          <RowActionsMenu items={items} ariaLabel={`Actions for ${job.componentName ?? 'this component'}`} busy={deletingId === job.jobId || busyId === job.jobId} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
