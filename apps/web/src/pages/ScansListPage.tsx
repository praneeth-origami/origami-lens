import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { ScanListItem, ScanStatus } from '@origami/contracts';
import { deleteScan, downloadReportExport, fetchScans, ApiRequestError } from '../api/client';
import { ErrorState } from '../components/StateViews';
import {
  DatabaseIcon,
  GlobeIcon,
  ClockIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
  DocumentIcon,
  MoreIcon,
} from '../components/icons';
import { lensEvent } from '../notifications/lens-event';
import { confirm } from '../notifications/confirm';
import { AnimatedScoreRing } from '../components/AnimatedScoreRing';

const REPORT_READY_STATUSES = new Set<ScanStatus>(['COMPLETED', 'COMPLETED_WITH_WARNINGS']);
const RUNNING_STATUSES = new Set<ScanStatus>(['QUEUED', 'RUNNING']);
const COMPLETED_STATUSES = new Set<ScanStatus>(['COMPLETED', 'COMPLETED_WITH_WARNINGS']);
const FAILED_STATUSES = new Set<ScanStatus>(['FAILED', 'CANCELLED']);

type ScanTab = 'all' | 'current' | 'website';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function scoreTier(score: number): 'good' | 'fair' | 'poor' {
  return score >= 90 ? 'good' : score >= 75 ? 'good' : score >= 60 ? 'fair' : 'poor';
}

interface ActionItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/** Generic portal-based "•••" menu — same pattern as RepositoriesListPage.tsx's RowActionsMenu, needed for the same reason: rows sit inside `.animate-in`, which traps position:fixed descendants unless portaled to document.body. */
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

export function ScansListPage() {
  const navigate = useNavigate();
  const [scans, setScans] = useState<ScanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [tab, setTab] = useState<ScanTab>('all');

  const load = () => {
    setLoading(true);
    setError(null);
    fetchScans()
      .then((data) => setScans(data.scans))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load scans'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const summary = useMemo(() => {
    let completed = 0;
    let running = 0;
    let failed = 0;
    for (const scan of scans) {
      const status = scan.status ?? 'COMPLETED';
      if (COMPLETED_STATUSES.has(status)) completed += 1;
      else if (RUNNING_STATUSES.has(status)) running += 1;
      else if (FAILED_STATUSES.has(status)) failed += 1;
    }
    return { total: scans.length, completed, running, failed };
  }, [scans]);

  const tabCounts = useMemo(() => {
    let current = 0;
    let website = 0;
    for (const scan of scans) {
      if (scan.scanType === 'WEBSITE') website += 1;
      else current += 1;
    }
    return { all: scans.length, current, website };
  }, [scans]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scans.filter((s) => {
      if (tab === 'current' && s.scanType === 'WEBSITE') return false;
      if (tab === 'website' && s.scanType !== 'WEBSITE') return false;
      if (!q) return true;
      return s.url.toLowerCase().includes(q) || hostnameOf(s.url).toLowerCase().includes(q);
    });
  }, [scans, query, tab]);

  const handleDelete = async (scan: ScanListItem) => {
    if (deletingId) return;
    const confirmed = await confirm({
      title: 'Delete scan?',
      description: `Delete the scan of ${hostnameOf(scan.url)}? This cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;

    setDeletingId(scan.scanId);
    try {
      await deleteScan(scan.scanId);
      setScans((prev) => prev.filter((s) => s.scanId !== scan.scanId));
      lensEvent.success('Scan deleted successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete scan');
    } finally {
      setDeletingId(null);
    }
  };

  const handleExport = async (scan: ScanListItem) => {
    setExportingId(scan.scanId);
    try {
      await downloadReportExport(scan.scanId, 'pdf');
      lensEvent.success('Exported as PDF');
    } catch (err) {
      if (!(err instanceof ApiRequestError)) lensEvent.error('Could not export the report.');
    } finally {
      setExportingId(null);
    }
  };

  return (
    <div className="list-page animate-in">
      <div className="page-heading-row workspace-heading-row">
        <div>
          <div className="page-eyebrow"><DatabaseIcon /> Scans</div>
          <h1 className="page-title">Website scans</h1>
          <p className="page-subtitle">Every Current Page and Entire Website scan you run with Origami Lens.</p>
        </div>
        <div className="workspace-header-card">
          <span className="workspace-header-card-icon" aria-hidden="true"><GlobeIcon /></span>
          <div>
            <div className="workspace-header-card-title">SCAN. ANALYZE. IMPROVE.</div>
            <div className="workspace-header-card-subtitle">Find issues, get insights and make better websites.</div>
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

      {!loading && !error && scans.length === 0 && (
        <div className="empty-state-card">
          <span className="empty-state-icon" aria-hidden="true"><GlobeIcon /></span>
          <h3>No scans yet</h3>
          <p>Run one from the Origami Lens Chrome extension to discover issues, get insights and make your website better.</p>
        </div>
      )}

      {!loading && !error && scans.length > 0 && (
        <>
          <div className="repo-summary-row">
            <div className="repo-summary-grid">
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon total" aria-hidden="true"><DatabaseIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{summary.total}</span>
                  <span className="repo-summary-tile-label">Total scans</span>
                  <span className="repo-summary-tile-hint">All time scans</span>
                </div>
              </div>
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon ready" aria-hidden="true"><CheckCircleIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{summary.completed}</span>
                  <span className="repo-summary-tile-label">Completed</span>
                  <span className="repo-summary-tile-hint">Scans finished</span>
                </div>
              </div>
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon processing" aria-hidden="true"><ClockIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{summary.running}</span>
                  <span className="repo-summary-tile-label">Running</span>
                  <span className="repo-summary-tile-hint">Currently in progress</span>
                </div>
              </div>
              <div className="repo-summary-tile">
                <span className="repo-summary-tile-icon failed" aria-hidden="true"><AlertTriangleIcon /></span>
                <div>
                  <span className="repo-summary-tile-count">{summary.failed}</span>
                  <span className="repo-summary-tile-label">Failed</span>
                  <span className="repo-summary-tile-hint">Scans with errors</span>
                </div>
              </div>
            </div>
          </div>

          <div className="workspace-toolbar">
            <div className="workspace-tabs" role="tablist" aria-label="Scan type">
              <button type="button" role="tab" aria-selected={tab === 'all'} className={`workspace-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
                All scans <span className="workspace-tab-count">{tabCounts.all}</span>
              </button>
              <button type="button" role="tab" aria-selected={tab === 'current'} className={`workspace-tab ${tab === 'current' ? 'active' : ''}`} onClick={() => setTab('current')}>
                <DocumentIcon /> Current pages <span className="workspace-tab-count">{tabCounts.current}</span>
              </button>
              <button type="button" role="tab" aria-selected={tab === 'website'} className={`workspace-tab ${tab === 'website' ? 'active' : ''}`} onClick={() => setTab('website')}>
                <GlobeIcon /> Entire websites <span className="workspace-tab-count">{tabCounts.website}</span>
              </button>
            </div>
            <div className="list-page-search repo-summary-search">
              <input
                type="search"
                className="search-input"
                placeholder="Filter by website…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Filter scans by website"
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state-card">
              <span className="empty-state-icon" aria-hidden="true"><GlobeIcon /></span>
              <h3>No scans match your filters</h3>
              <p>Try a different website, or switch to a different scan type.</p>
            </div>
          ) : (
            <div className="record-table-wrap">
              <table className="record-table repo-table">
                <thead>
                  <tr>
                    <th>Website</th>
                    <th>Type</th>
                    <th>Health</th>
                    <th>Issues</th>
                    <th>Scanned</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((scan) => {
                    const status = scan.status ?? 'COMPLETED';
                    const isWebsite = scan.scanType === 'WEBSITE';
                    const reportReady = REPORT_READY_STATUSES.has(status);
                    const hasSeverityBreakdown = [scan.critical, scan.high, scan.medium, scan.low].some((n) => typeof n === 'number' && n > 0);
                    const items: ActionItem[] = [
                      { label: 'View report', onClick: () => navigate(`/scans/${scan.scanId}`) },
                      {
                        label: exportingId === scan.scanId ? 'Exporting…' : 'Export report',
                        disabled: !reportReady || exportingId === scan.scanId,
                        onClick: () => void handleExport(scan),
                      },
                      { label: 'Delete scan', destructive: true, disabled: deletingId === scan.scanId, onClick: () => void handleDelete(scan) },
                    ];
                    return (
                      <tr
                        key={scan.scanId}
                        onClick={() => navigate(`/scans/${scan.scanId}`)}
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) navigate(`/scans/${scan.scanId}`); }}
                      >
                        <td data-label="Website">
                          <div className="repo-identity">
                            <span className="repo-identity-icon" aria-hidden="true"><GlobeIcon /></span>
                            <div>
                              <span className="record-primary">{hostnameOf(scan.url)}</span>
                              <span className="record-secondary">{scan.url}</span>
                            </div>
                          </div>
                        </td>
                        <td data-label="Type">
                          <span className="repo-provider-cell">
                            {isWebsite ? <GlobeIcon /> : <DocumentIcon />}
                            {isWebsite ? 'Entire Website' : 'Current Page'}
                          </span>
                        </td>
                        <td data-label="Health">
                          {RUNNING_STATUSES.has(status) ? (
                            <span className={`status-pill ${status.toLowerCase()}`}>Scanning…</span>
                          ) : status === 'FAILED' || status === 'CANCELLED' ? (
                            <span className={`status-pill ${status.toLowerCase()}`}>{status === 'FAILED' ? 'Failed' : 'Cancelled'}</span>
                          ) : (
                            <AnimatedScoreRing
                              score={scan.overallScore}
                              tier={scoreTier(scan.overallScore)}
                              small
                              ariaLabel={`Health score ${scan.overallScore} out of 100`}
                            />
                          )}
                        </td>
                        <td data-label="Issues">
                          <span className="record-primary">{scan.totalIssues} issue{scan.totalIssues === 1 ? '' : 's'}</span>
                          {hasSeverityBreakdown && (
                            <span className="record-secondary">
                              {[
                                scan.critical ? `${scan.critical} critical` : null,
                                scan.high ? `${scan.high} high` : null,
                                scan.medium ? `${scan.medium} medium` : null,
                                scan.low ? `${scan.low} low` : null,
                              ].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </td>
                        <td data-label="Scanned">{new Date(scan.scannedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                        <td data-label="Actions" className="repo-actions-cell">
                          <RowActionsMenu items={items} ariaLabel={`Actions for scan of ${hostnameOf(scan.url)}`} busy={deletingId === scan.scanId} />
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
