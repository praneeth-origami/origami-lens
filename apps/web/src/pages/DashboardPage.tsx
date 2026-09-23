import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { AggregatedIssue, Issue, IssueCategory, IssueFilters, ScanResponse } from '@origami/contracts';
import {
  fetchRepositories,
  fetchScan,
  fetchScanIssues,
  fetchScanStatus,
  fetchScans,
  type SeverityTab,
} from '../api/client';
import { lensEvent } from '../notifications/lens-event';
import {
  CategoryScoreList,
  HealthSummary,
  ScanSummary,
} from '../components/ScanSummary';
import { IssueFiltersBar } from '../components/IssueFilters';
import { IssueList } from '../components/IssueList';
import { EmptyState, ErrorState, LoadingSkeleton } from '../components/StateViews';
import { ScreenshotViewer } from '../components/ScreenshotViewer';
import { PagesTable, WebsiteScanPanel } from '../components/WebsiteScanPanel';
import { RecentActivity } from '../components/RecentActivity';
import { PersonaCta } from '../components/PersonaCta';
import { Disclosure } from '../components/Disclosure';

type ScanWithMeta = ScanResponse & { issuesByCategory?: Record<string, number> };

const TERMINAL_STATUSES = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];

function totalIssueCount(scanData: ScanWithMeta): number {
  if (!scanData.issuesByCategory) return 0;
  return Object.values(scanData.issuesByCategory).reduce((sum, n) => sum + n, 0);
}

/** Morphs the scan's own Lens Active card into its terminal state (spec §14) — callers guard this against re-firing per scan via a ref (see the two polling effects below), since either can independently detect the same terminal transition. */
function completeScanEvent(eventId: string, scanData: ScanWithMeta): void {
  if (scanData.status === 'FAILED') {
    lensEvent.complete(eventId, { type: 'error', title: 'Scan failed', resource: scanData.url, detail: 'Please try again.' });
  } else if (scanData.status === 'CANCELLED') {
    lensEvent.complete(eventId, { type: 'warning', title: 'Scan cancelled', resource: scanData.url });
  } else if (scanData.status === 'COMPLETED' || scanData.status === 'COMPLETED_WITH_WARNINGS') {
    const count = totalIssueCount(scanData);
    lensEvent.complete(eventId, {
      type: 'success',
      title: 'Scan completed',
      resource: scanData.url,
      detail: count > 0 ? `${count} issue${count === 1 ? '' : 's'} detected` : 'No issues found',
    });
  }
}

/** Same as RepositoriesListPage.tsx's own repoName — duplicated locally rather than shared, matching this codebase's existing convention for small single-purpose display helpers. */
function repoName(repoUrl: string): string {
  try {
    return new URL(repoUrl).pathname.replace(/^\//, '');
  } catch {
    return repoUrl;
  }
}

export function DashboardPage() {
  const { scanId: paramScanId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [scan, setScan] = useState<ScanWithMeta | null>(null);
  const [issues, setIssues] = useState<(Issue | AggregatedIssue)[]>([]);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof fetchScans>>['scans']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [severityTab, setSeverityTab] = useState<SeverityTab>('all');
  const [filters, setFilters] = useState<IssueFilters>({ sort: 'severity' });
  const [repositoryNamesById, setRepositoryNamesById] = useState<Record<string, string>>({});
  /** Tracks this scan's own Lens Active card — both polling effects below can independently detect the same in-progress/terminal transitions, and either effect can re-run (e.g. when the user changes a filter mid-scan) without the scan itself having changed, so this is keyed by scanId rather than recreated on every effect run. */
  const activeScanEventRef = useRef<{ scanId: string; eventId: string } | null>(null);

  function getOrCreateScanEvent(scanId: string, scanData: ScanWithMeta): string {
    if (activeScanEventRef.current?.scanId === scanId) return activeScanEventRef.current.eventId;
    const eventId = lensEvent.active({
      title: scanData.scanType === 'WEBSITE' ? 'Scanning website' : 'Running inspection',
      resource: scanData.url,
    });
    activeScanEventRef.current = { scanId, eventId };
    return eventId;
  }

  const activeScanId = paramScanId ?? history[0]?.scanId;
  const isFresh = searchParams.get('fresh') === '1';

  const mergedFilters = useMemo<IssueFilters>(() => ({
    ...filters,
    severity: severityTab === 'all' ? filters.severity ?? 'all' : severityTab,
  }), [filters, severityTab]);

  const loadHistory = useCallback(async () => {
    const data = await fetchScans();
    setHistory(data.scans);
    return data.scans;
  }, []);

  const loadScan = useCallback(async (scanId: string, silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const [scanData, issuesData] = await Promise.all([
        fetchScan(scanId),
        fetchScanIssues(scanId, mergedFilters),
      ]);
      setScan(scanData);
      setIssues(issuesData.issues);
      return scanData;
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : 'Failed to load scan');
        setScan(null);
        setIssues([]);
      }
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, [mergedFilters]);

  useEffect(() => {
    loadHistory().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load scans');
      setLoading(false);
    });
  }, [loadHistory]);

  useEffect(() => {
    fetchRepositories()
      .then((res) => setRepositoryNamesById(Object.fromEntries(res.repositories.map((r) => [r.id, repoName(r.repoUrl)]))))
      .catch(() => setRepositoryNamesById({}));
  }, []);

  useEffect(() => {
    if (!activeScanId) {
      setLoading(false);
      return;
    }
    if (!paramScanId) {
      navigate(`/scans/${activeScanId}`, { replace: true });
    }
  }, [activeScanId, paramScanId, navigate]);

  useEffect(() => {
    if (!activeScanId) return;
    loadScan(activeScanId);
  }, [activeScanId, loadScan]);

  useEffect(() => {
    if (!isFresh || !activeScanId) return;

    let attempts = 0;
    const maxAttempts = 60;

    const id = setInterval(async () => {
      attempts += 1;
      const data = await loadScan(activeScanId, true);
      if (data) {
        const isTerminal = Boolean(data.status && TERMINAL_STATUSES.includes(data.status));
        const alreadyTracked = activeScanEventRef.current?.scanId === activeScanId;
        if (!isTerminal && !alreadyTracked) {
          getOrCreateScanEvent(activeScanId, data);
        } else if (!isTerminal && alreadyTracked && data.progress) {
          const { completedPages, discoveredPages } = data.progress;
          const pct = discoveredPages > 0 ? Math.round((completedPages / discoveredPages) * 100) : undefined;
          lensEvent.updateProgress(activeScanEventRef.current!.eventId, { progress: pct, detail: `${completedPages} / ${discoveredPages} pages` });
        } else if (isTerminal && alreadyTracked) {
          completeScanEvent(activeScanEventRef.current!.eventId, data);
          activeScanEventRef.current = null;
        }
        if (!data.status || isTerminal || attempts >= maxAttempts) {
          clearInterval(id);
          searchParams.delete('fresh');
          setSearchParams(searchParams, { replace: true });
        }
      } else if (attempts >= maxAttempts) {
        clearInterval(id);
      }
    }, 2000);

    return () => clearInterval(id);
  }, [isFresh, activeScanId, loadScan, searchParams, setSearchParams]);

  useEffect(() => {
    if (!activeScanId || !scan || scan.scanType !== 'WEBSITE') return;
    if (scan.status && TERMINAL_STATUSES.includes(scan.status)) return;

    const id = setInterval(async () => {
      try {
        const status = await fetchScanStatus(activeScanId);
        if (TERMINAL_STATUSES.includes(status.status)) {
          const data = await loadScan(activeScanId, true);
          if (data && activeScanEventRef.current?.scanId === activeScanId) {
            completeScanEvent(activeScanEventRef.current.eventId, data);
            activeScanEventRef.current = null;
          }
          clearInterval(id);
        } else {
          if (scan && activeScanEventRef.current?.scanId !== activeScanId) {
            getOrCreateScanEvent(activeScanId, scan);
          }
          if (activeScanEventRef.current?.scanId === activeScanId && status.progress) {
            const { completedPages, discoveredPages } = status.progress;
            const pct = discoveredPages > 0 ? Math.round((completedPages / discoveredPages) * 100) : undefined;
            lensEvent.updateProgress(activeScanEventRef.current.eventId, { progress: pct, detail: `${completedPages} / ${discoveredPages} pages` });
          }
          setScan((prev) =>
            prev
              ? { ...prev, status: status.status, progress: status.progress, healthScore: status.healthScore ?? prev.healthScore }
              : prev,
          );
        }
      } catch {
        // ignore poll errors
      }
    }, 2000);

    return () => clearInterval(id);
  }, [activeScanId, scan?.scanType, scan?.status, loadScan]);

  const handleSelectScan = (scanId: string) => {
    navigate(`/scans/${scanId}`);
  };

  const handleSelectCategory = (category: IssueCategory) => {
    setSeverityTab('all');
    setFilters((f) => ({ ...f, category }));
    requestAnimationFrame(() => {
      document.getElementById('issues-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  if (error && !scan) {
    return (
      <div className="dashboard">
        <ErrorState message={error} onRetry={() => activeScanId && loadScan(activeScanId)} />
      </div>
    );
  }

  const hasPages = Boolean(scan?.pages && scan.pages.length > 0);

  return (
    <div className="dashboard">
      <PersonaCta />

      {loading && <LoadingSkeleton />}

      {!loading && !scan && <EmptyState hasScans={history.length > 0} />}

      {!loading && scan && (
        <>
          {/* 1. Scan/site identity */}
          <ScanSummary scan={scan} scans={history} activeScanId={activeScanId} onSelectScan={handleSelectScan} />

          {/* 2. Health Score + issue summary, consolidated into one strip */}
          <HealthSummary scan={scan} />

          {/* 3. Compact category summary */}
          <CategoryScoreList scan={scan} onSelectCategory={handleSelectCategory} />

          {scan.aiSummary?.summary && (
            <section className="ai-summary-block animate-in">
              <h3>AI Scan Summary</h3>
              <p>{scan.aiSummary.summary}</p>
            </section>
          )}

          {/* 4. Issues — the primary section */}
          <section id="issues-section" className="issues-section animate-in">
            <div className="page-heading-row">
              <h2 className="section-title">Issues</h2>
              <span className="issues-total">{scan.summary.totalIssues} total</span>
            </div>

            {scan.summary.totalIssues === 0 ? (
              <div className="empty-state inline">
                <p>Great! No issues were detected on this scan.</p>
              </div>
            ) : (
              <>
                <IssueFiltersBar
                  severityTab={severityTab}
                  onSeverityTab={setSeverityTab}
                  filters={filters}
                  onFiltersChange={setFilters}
                />
                <IssueList issues={issues} repositoryNamesById={repositoryNamesById} />
              </>
            )}
          </section>

          {/* 5. Everything below is real, complete data kept behind
              progressive disclosure so it doesn't compete with the issues
              above for vertical space — nothing here is removed. */}
          {scan.scanType === 'WEBSITE' && (
            <Disclosure title="Website scan details" meta={hasPages ? `${scan.pages!.length} pages` : undefined}>
              <WebsiteScanPanel scan={scan} />
              <PagesTable scanId={scan.scanId} pages={scan.pages} />
            </Disclosure>
          )}

          <ScreenshotViewer scanId={scan.scanId} artifacts={scan.artifacts} />

          <Disclosure title="Recent activity">
            <RecentActivity scans={history} activeScanId={activeScanId} onSelect={handleSelectScan} />
          </Disclosure>
        </>
      )}
    </div>
  );
}
