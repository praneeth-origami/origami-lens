import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { AggregatedIssue, Issue, IssueCategory, IssueFilters, ScanResponse } from '@origami/contracts';
import {
  fetchScan,
  fetchScanIssues,
  fetchScanStatus,
  fetchScans,
  type SeverityTab,
} from '../api/client';
import {
  CategoryScoreList,
  HealthScoreCard,
  IssueSummaryCards,
  KeyMetrics,
  ScanSummary,
} from '../components/ScanSummary';
import { IssueFiltersBar } from '../components/IssueFilters';
import { IssueList } from '../components/IssueList';
import { EmptyState, ErrorState, LoadingSkeleton } from '../components/StateViews';
import { ScreenshotViewer } from '../components/ScreenshotViewer';
import { PagesTable, WebsiteScanPanel } from '../components/WebsiteScanPanel';
import { RecentActivity } from '../components/RecentActivity';

type ScanWithMeta = ScanResponse & { issuesByCategory?: Record<string, number> };

const TERMINAL_STATUSES = ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'];

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
        if (!data.status || TERMINAL_STATUSES.includes(data.status) || attempts >= maxAttempts) {
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
          await loadScan(activeScanId, true);
          clearInterval(id);
        } else {
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

  return (
    <div className="dashboard">
      {loading && <LoadingSkeleton />}

      {!loading && !scan && <EmptyState hasScans={history.length > 0} />}

      {!loading && scan && (
        <>
          <ScanSummary scan={scan} scans={history} activeScanId={activeScanId} onSelectScan={handleSelectScan} />

          <div className="hero-grid animate-in">
            <HealthScoreCard scan={scan} />
            <KeyMetrics scan={scan} />
          </div>

          <CategoryScoreList scan={scan} onSelectCategory={handleSelectCategory} />

          <WebsiteScanPanel scan={scan} />
          <PagesTable scanId={scan.scanId} pages={scan.pages} />

          <ScreenshotViewer scanId={scan.scanId} artifacts={scan.artifacts} />

          {scan.aiSummary?.summary && (
            <section className="ai-summary-block animate-in">
              <h3>AI Scan Summary</h3>
              <p>{scan.aiSummary.summary}</p>
            </section>
          )}

          <section id="issues-section" className="issues-section animate-in">
            <div className="page-heading-row">
              <h2 className="section-title">Issues Found</h2>
            </div>
            <IssueSummaryCards scan={scan} />

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
                <IssueList issues={issues} />
              </>
            )}
          </section>

          <RecentActivity scans={history} activeScanId={activeScanId} onSelect={handleSelectScan} />
        </>
      )}
    </div>
  );
}
