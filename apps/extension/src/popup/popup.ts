import { API_BASE, DASHBOARD_BASE, type ScanResult } from '../types/scan.js';
import type { PersistedActiveScan } from '../shared/scan-storage.js';
import { isInProgressStatus, isTerminalStatus } from '../shared/scan-storage.js';
import type { ResponsiveTestMessageResponse, StartScanResponse } from '../shared/messages.js';
import type { PersistedResponsiveTest } from '../shared/responsive-test-storage.js';
import { RESPONSIVE_TEST_STORAGE_KEY } from '../shared/responsive-test-storage.js';
import type { PersistedComponentJob } from '../shared/component-storage.js';
import { isComponentJobInProgress, isComponentJobTerminal } from '../shared/component-storage.js';
import { DEFAULT_RESPONSIVE_WIDTHS } from '@origami/contracts';
import type { Issue, IssueCategory, ResponsiveTestResult, ResponsiveViewportResult, Severity } from '@origami/contracts';
import type { BugReportFormInput, CreateBugReportMessageResponse } from '../shared/messages.js';

type ViewId =
  | 'initial'
  | 'website-config'
  | 'scanning'
  | 'website-progress'
  | 'results'
  | 'issue-detail'
  | 'responsive-progress'
  | 'responsive-results'
  | 'responsive-issue-detail'
  | 'bug-report-form'
  | 'bug-report-result'
  | 'error'
  | 'auth-required';

interface ScanStatusResponse {
  scanId: string;
  scanType: string;
  status: string;
  progress: {
    discoveredPages: number;
    completedPages: number;
    failedPages: number;
    issuesFound: number;
  };
  healthScore?: { overallScore: number };
  error?: string;
}

interface PageScanRecord {
  pageScanId: string;
  url: string;
  status: string;
  error?: string;
}

let currentScan: ScanResult | null = null;
let selectedIssueId: string | null = null;
let popupPollTimer: ReturnType<typeof setInterval> | null = null;

const SCORE_RING_CIRCUMFERENCE = 238.76;

const views: Record<ViewId, HTMLElement> = {
  initial: document.getElementById('view-initial')!,
  'website-config': document.getElementById('view-website-config')!,
  scanning: document.getElementById('view-scanning')!,
  'website-progress': document.getElementById('view-website-progress')!,
  results: document.getElementById('view-results')!,
  'issue-detail': document.getElementById('view-issue-detail')!,
  'responsive-progress': document.getElementById('view-responsive-progress')!,
  'responsive-results': document.getElementById('view-responsive-results')!,
  'responsive-issue-detail': document.getElementById('view-responsive-issue-detail')!,
  'bug-report-form': document.getElementById('view-bug-report-form')!,
  'bug-report-result': document.getElementById('view-bug-report-result')!,
  error: document.getElementById('view-error')!,
  'auth-required': document.getElementById('view-auth-required')!,
};

const CATEGORY_LABELS: Record<string, string> = {
  functional: 'Functional',
  performance: 'Performance',
  visualMobile: 'Visual / Mobile',
  accessibility: 'Accessibility',
  bestPractices: 'Best Practices',
  seo: 'SEO',
  securityHygiene: 'Security',
};

function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve((response ?? {}) as T);
    });
  });
}

function showView(id: ViewId) {
  for (const [key, el] of Object.entries(views)) {
    el.classList.toggle('hidden', key !== id);
  }
}

function stopPopupPolling() {
  if (popupPollTimer) {
    clearInterval(popupPollTimer);
    popupPollTimer = null;
  }
}

function friendlyError(raw: string, errorCode?: string): { title: string; body: string; detail?: string } {
  // Checked BEFORE the substring heuristics below: a real API errorCode is an
  // exact, authoritative signal (see PersistedActiveScan.errorCode's doc
  // comment) and must never be shadowed by a coincidental keyword match in
  // the message text. USAGE_LIMIT_EXCEEDED's server message is already
  // specific and accurate ("Daily limit reached for your plan (N
  // inspections/day). Upgrade to continue.") — shown directly rather than
  // re-worded, so the real plan/limit numbers never go stale here.
  if (errorCode === 'USAGE_LIMIT_EXCEEDED') {
    return { title: 'Daily limit reached', body: raw };
  }
  // UNAUTHENTICATED is handled entirely separately — see setError, which
  // routes it to the dedicated #view-auth-required view instead of calling
  // this function at all (it's a real permission state, not a failure, and
  // gets its own richer layout rather than reusing the generic error view).

  const lower = raw.toLowerCase();
  if (lower.includes('timeout') || lower.includes('abort')) {
    return {
      title: 'Something went wrong',
      body: "Origami Lens couldn't complete this scan. The page may be unavailable or the connection timed out.",
      detail: raw,
    };
  }
  if (lower.includes('postgresql') || lower.includes('redis') || lower.includes('database')) {
    return {
      title: 'Something went wrong',
      body: 'Website scans require PostgreSQL and Redis. Start infrastructure with docker compose and run pnpm db:migrate.',
      detail: raw,
    };
  }
  if (lower.includes('browser worker') || lower.includes('backend unavailable') || lower.includes('pnpm dev')) {
    return {
      title: 'Something went wrong',
      body: 'Origami Lens could not reach the backend services. Start the dev stack with pnpm dev.',
      detail: raw,
    };
  }
  if (lower.includes('restricted') || lower.includes('chrome://')) {
    return {
      title: 'Something went wrong',
      body: 'This page cannot be scanned. Open a regular http(s) webpage and try again.',
      detail: raw,
    };
  }
  if (lower.includes('already in progress')) {
    return {
      title: 'Scan in progress',
      body: raw,
    };
  }
  return {
    title: 'Something went wrong',
    body: "Origami Lens couldn't complete this scan. The page may be unavailable or the connection may have timed out.",
    detail: raw,
  };
}

function setError(message: string, errorCode?: string) {
  // A real permission state, not a failure — its own dedicated view (see
  // popup.html's #view-auth-required) rather than the generic error view.
  if (errorCode === 'UNAUTHENTICATED') {
    showAuthRequired();
    return;
  }

  const err = friendlyError(message, errorCode);
  const titleEl = document.querySelector('#view-error .page-title');
  if (titleEl) titleEl.textContent = err.title;
  document.getElementById('error-message')!.textContent = err.body;
  const detailEl = document.getElementById('error-detail')!;
  if (err.detail && err.detail !== err.body) {
    detailEl.textContent = err.detail;
    detailEl.classList.remove('hidden');
  } else {
    detailEl.textContent = '';
    detailEl.classList.add('hidden');
  }

  // "Try again" makes no sense for a plan/quota limit — retrying just hits
  // the same 402 until the limit resets. Show "View Plans" instead for that
  // one case; every other error keeps the original retry button unchanged.
  const viewPlansBtn = document.getElementById('view-plans-btn') as HTMLAnchorElement;
  const retryBtn = document.getElementById('retry-btn')!;
  const isPlanLimit = errorCode === 'USAGE_LIMIT_EXCEEDED';
  retryBtn.classList.toggle('hidden', isPlanLimit);
  viewPlansBtn.classList.toggle('hidden', !isPlanLimit);
  if (isPlanLimit) {
    viewPlansBtn.href = `${dashboardOrigin()}/pricing`;
  }

  showView('error');
}

function showAuthRequired() {
  const signInBtn = document.getElementById('auth-sign-in-btn') as HTMLAnchorElement;
  signInBtn.href = `${dashboardOrigin()}/login`;
  showView('auth-required');
}

function parseHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function scoreVerdict(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 60) return 'Fair';
  return 'Needs attention';
}

function setScoreRing(score: number) {
  const ring = document.getElementById('score-ring-progress') as SVGCircleElement | null;
  if (!ring) return;
  const clamped = Math.min(100, Math.max(0, score));
  const offset = SCORE_RING_CIRCUMFERENCE - (clamped / 100) * SCORE_RING_CIRCUMFERENCE;
  ring.style.strokeDashoffset = String(offset);
  if (clamped >= 75) ring.style.stroke = 'var(--success)';
  else if (clamped >= 60) ring.style.stroke = 'var(--warning)';
  else ring.style.stroke = 'var(--danger)';
}

function updateCurrentSiteDisplay(url: string) {
  document.getElementById('current-site-host')!.textContent = parseHostname(url);
  const urlEl = document.getElementById('current-site-url')!;
  urlEl.textContent = url;
  urlEl.title = url;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const response = await sendRuntimeMessage<{ tab?: chrome.tabs.Tab | null }>({
    type: 'GET_ACTIVE_TAB',
  });
  return response.tab ?? null;
}

function isRestrictedUrl(url: string): boolean {
  return url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://');
}

function getOriginFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

interface DependencyHealth {
  api: { status: string };
  browserWorker: { status: string };
  aiRouter: { status: string };
  readyForScan: boolean;
}

async function checkBackendHealth(): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`${API_BASE}/health/dependencies`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return { ok: false, message: 'Origami API is not responding. Run pnpm dev in the project root.' };
    }
    const data = (await res.json()) as DependencyHealth;
    if (data.api?.status !== 'ok') {
      return { ok: false, message: 'Origami API is down. Run pnpm dev in the project root.' };
    }
    if (data.browserWorker?.status !== 'ok') {
      return {
        ok: false,
        message: 'Browser worker is down (port 3101). Run pnpm dev — scans will fail without it.',
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: 'Backend unavailable. Start services with pnpm dev.' };
  }
}

async function animateScanSteps() {
  const steps = document.querySelectorAll('#scan-steps li');
  for (let i = 0; i < steps.length; i++) {
    steps.forEach((s, j) => {
      s.classList.toggle('active', j === i);
      s.classList.toggle('done', j < i);
    });
    await new Promise((r) => setTimeout(r, 350));
  }
  steps.forEach((s) => {
    s.classList.remove('active');
    s.classList.add('done');
  });
}

async function loadCompletedScan(scanId: string, isWebsite: boolean): Promise<boolean> {
  try {
    const scanRes = await fetch(`${API_BASE}/scans/${scanId}`, { signal: AbortSignal.timeout(15000) });
    if (!scanRes.ok) {
      setError('Scan completed but report could not be loaded.');
      return false;
    }
    currentScan = (await scanRes.json()) as ScanResult;
    renderResults(currentScan, isWebsite);
    showView('results');
    return true;
  } catch {
    setError('Scan completed but report could not be loaded.');
    return false;
  }
}

async function applyActiveScanToUI(activeScan: PersistedActiveScan): Promise<boolean> {
  if (activeScan.scanType === 'WEBSITE') {
    document.getElementById('website-scan-url')!.textContent = activeScan.targetUrl;

    if (isInProgressStatus(activeScan.status)) {
      showView('website-progress');
      const pages =
        activeScan.progress.discoveredPages > 0 && activeScan.scanId !== 'pending'
          ? await fetchWebsitePages(activeScan.scanId)
          : [];
      updateWebsiteProgressUI(activeScan.progress, activeScan.status, phaseMessage(activeScan), pages);
      return true;
    }

    if (activeScan.status === 'FAILED' || activeScan.status === 'CANCELLED') {
      setError(activeScan.error ?? 'Website scan failed.', activeScan.errorCode);
      return true;
    }

    if (isTerminalStatus(activeScan.status) && activeScan.scanId !== 'pending') {
      return loadCompletedScan(activeScan.scanId, true);
    }
  }

  if (activeScan.scanType === 'CURRENT_PAGE') {
    document.getElementById('scan-status-title')!.textContent = 'Scanning page';
    document.getElementById('scanning-url')!.textContent = activeScan.targetUrl;

    if (isInProgressStatus(activeScan.status)) {
      showView('scanning');
      return true;
    }

    if (activeScan.status === 'FAILED' || activeScan.status === 'CANCELLED') {
      setError(activeScan.error ?? 'Page scan failed.', activeScan.errorCode);
      return true;
    }

    if (isTerminalStatus(activeScan.status) && activeScan.scanId !== 'pending') {
      return loadCompletedScan(activeScan.scanId, false);
    }
  }

  return false;
}

function phaseMessage(activeScan: PersistedActiveScan): string {
  const { progress, status } = activeScan;
  if (status === 'QUEUED' || progress.discoveredPages === 0) return 'Discovering pages…';
  if (progress.completedPages + progress.failedPages < progress.discoveredPages) return 'Scanning pages…';
  return 'Generating report…';
}

async function refreshScanStateFromBackground(): Promise<PersistedActiveScan | null> {
  const response = await sendRuntimeMessage<{ activeScan?: PersistedActiveScan | null }>({
    type: 'GET_SCAN_STATE',
  });
  return response.activeScan ?? null;
}

function startPopupPolling() {
  stopPopupPolling();

  const poll = async () => {
    try {
      const activeScan = await refreshScanStateFromBackground();
      if (!activeScan) {
        stopPopupPolling();
        return;
      }

      await applyActiveScanToUI(activeScan);

      if (isTerminalStatus(activeScan.status)) {
        stopPopupPolling();
      }
    } catch {
      const hint = document.getElementById('website-progress-phase');
      if (hint && !views['website-progress'].classList.contains('hidden')) {
        hint.textContent = 'Connection temporarily unavailable — scan continues on the server.';
      }
    }
  };

  void poll();
  popupPollTimer = setInterval(poll, 2000);
}

/** CURRENT_PAGE scans are matched by exact URL (that's the granularity they were run at); WEBSITE scans are matched by origin, since the crawl covers many pages under that one root. */
function scanMatchesTab(activeScan: PersistedActiveScan, tabUrl: string | undefined): boolean {
  if (!tabUrl) return false;
  if (activeScan.scanType === 'WEBSITE') {
    return getOriginFromUrl(activeScan.targetUrl) === getOriginFromUrl(tabUrl);
  }
  return activeScan.targetUrl === tabUrl;
}

async function restoreScanStateOnOpen() {
  const activeScan = await refreshScanStateFromBackground();
  if (!activeScan) return;

  // An in-progress scan is background work worth resuming regardless of
  // which tab is now active (a website crawl keeps running after you
  // switch tabs) — but a scan that already finished should only take over
  // the popup's main view when it's for the site you're currently on.
  // Without this check, opening the popup on a brand-new site kept showing
  // whatever report was scanned last, no matter what site that actually was.
  if (isTerminalStatus(activeScan.status)) {
    const tab = await getActiveTab();
    if (!scanMatchesTab(activeScan, tab?.url)) return;
  }

  const handled = await applyActiveScanToUI(activeScan);
  if (handled && isInProgressStatus(activeScan.status)) {
    startPopupPolling();
  }
}

async function startCurrentPageScan() {
  const health = await checkBackendHealth();
  if (!health.ok) {
    setError(health.message ?? 'Backend unavailable.');
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) {
    setError('No active tab found.');
    return;
  }

  if (isRestrictedUrl(tab.url)) {
    setError('Cannot inspect restricted Chrome pages. Open a regular webpage.');
    return;
  }

  const targetUrl = tab.url;

  document.getElementById('scan-status-title')!.textContent = 'Scanning page';
  document.getElementById('scanning-url')!.textContent = targetUrl;
  showView('scanning');

  const stepsPromise = animateScanSteps();

  let pageEvidence = null;
  try {
    pageEvidence = await sendRuntimeMessage<{ success: boolean; evidence?: unknown; error?: string }>({
      type: 'COLLECT_FROM_TAB',
      tabId: tab.id,
    });

    if (!pageEvidence?.success) {
      setError(
        pageEvidence?.error ??
          'Could not access page. Try a normal http(s) tab or refresh and try again.',
      );
      return;
    }
  } catch {
    setError('Failed to collect page evidence.');
    return;
  }

  startPopupPolling();

  const result = await sendRuntimeMessage<{ ok: boolean; scan?: ScanResult; error?: string; errorCode?: string }>({
    type: 'START_CURRENT_PAGE_SCAN',
    targetUrl,
    pageEvidence: pageEvidence.evidence,
  });

  await stepsPromise;
  stopPopupPolling();

  if (!result.ok) {
    setError(result.error ?? 'Scan failed.', result.errorCode);
    return;
  }

  if (result.scan) {
    currentScan = result.scan;
    renderResults(currentScan, false);
    showView('results');
  } else {
    await restoreScanStateOnOpen();
  }
}

async function showWebsiteConfig() {
  const activeScan = await refreshScanStateFromBackground();
  if (activeScan && isInProgressStatus(activeScan.status)) {
    await applyActiveScanToUI(activeScan);
    startPopupPolling();
    return;
  }

  const tab = await getActiveTab();
  const origin = tab?.url && !isRestrictedUrl(tab.url) ? getOriginFromUrl(tab.url) : '';
  (document.getElementById('website-url') as HTMLInputElement).value = origin;
  showView('website-config');
}

async function startWebsiteScan(event?: Event) {
  event?.preventDefault();

  const health = await checkBackendHealth();
  if (!health.ok) {
    setError(health.message ?? 'Backend unavailable.');
    return;
  }

  const url = (document.getElementById('website-url') as HTMLInputElement).value.trim();
  const discoveryMethod = (document.getElementById('discovery-method') as HTMLSelectElement).value;
  const maxPages = Number((document.getElementById('max-pages') as HTMLInputElement).value) || 20;
  const manualText = (document.getElementById('manual-urls') as HTMLTextAreaElement).value.trim();

  if (!url) {
    setError('Website URL is required.');
    return;
  }

  try {
    new URL(url);
  } catch {
    setError('Invalid website URL.');
    return;
  }

  document.getElementById('website-scan-url')!.textContent = url;
  showView('website-progress');
  updateWebsiteProgressUI(
    { discoveredPages: 0, completedPages: 0, failedPages: 0, issuesFound: 0 },
    'QUEUED',
    'Queuing website scan…',
    [],
  );

  const result = await sendRuntimeMessage<StartScanResponse>({
    type: 'START_WEBSITE_SCAN',
    options: {
      url,
      discoveryMethod,
      maxPages: Math.min(maxPages, 50),
      manualUrls: discoveryMethod === 'MANUAL' && manualText ? manualText.split('\n') : undefined,
    },
  });

  if (!result.ok) {
    if (result.error?.toLowerCase().includes('already in progress')) {
      await restoreScanStateOnOpen();
      return;
    }
    setError(result.error ?? 'Failed to start website scan.', result.errorCode);
    return;
  }

  startPopupPolling();
}

function pageStatusClass(status: string): string {
  if (status === 'COMPLETED') return 'done';
  if (status === 'FAILED') return 'failed';
  if (status === 'RUNNING') return 'active';
  return 'pending';
}

function pageStatusSymbol(status: string): string {
  if (status === 'COMPLETED') return '✓';
  if (status === 'FAILED') return '✕';
  if (status === 'RUNNING') return '◌';
  return '·';
}

function renderWebsitePageList(pages: PageScanRecord[]) {
  const listEl = document.getElementById('website-page-list')!;
  listEl.innerHTML = '';

  if (pages.length === 0) {
    const li = document.createElement('li');
    li.className = 'pending';
    li.innerHTML = '<span class="page-status-icon">·</span><span class="page-url">Discovering pages…</span>';
    listEl.appendChild(li);
    return;
  }

  for (const page of pages.slice(0, 12)) {
    const li = document.createElement('li');
    li.className = pageStatusClass(page.status);
    const path = (() => {
      try {
        const u = new URL(page.url);
        return u.pathname === '/' ? u.hostname : `${u.hostname}${u.pathname}`;
      } catch {
        return page.url;
      }
    })();
    li.innerHTML = `<span class="page-status-icon">${pageStatusSymbol(page.status)}</span><span class="page-url" title="${escapeHtml(page.url)}">${escapeHtml(path)}</span>`;
    listEl.appendChild(li);
  }

  if (pages.length > 12) {
    const li = document.createElement('li');
    li.className = 'pending';
    li.innerHTML = `<span class="page-status-icon">·</span><span class="page-url">+ ${pages.length - 12} more pages</span>`;
    listEl.appendChild(li);
  }
}

function updateWebsiteProgressUI(
  progress: ScanStatusResponse['progress'],
  status: string,
  message: string,
  pages: PageScanRecord[] = [],
) {
  document.getElementById('website-progress-phase')!.textContent = message;

  const total = progress.discoveredPages || 0;
  const done = progress.completedPages + progress.failedPages;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const bar = document.getElementById('website-progress-bar')!;
  bar.style.width = `${pct}%`;

  document.getElementById('website-progress-count')!.textContent =
    total > 0 ? `${done} / ${total} pages scanned` : status === 'QUEUED' ? 'Queuing scan…' : 'Discovering pages…';

  document.getElementById('website-progress-issues')!.textContent =
    `Issues found: ${progress.issuesFound}`;

  renderWebsitePageList(pages);
}

async function fetchWebsitePages(scanId: string): Promise<PageScanRecord[]> {
  if (!scanId || scanId === 'pending') return [];
  try {
    const res = await fetch(`${API_BASE}/scans/${scanId}/pages`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { pages: PageScanRecord[] };
    return data.pages ?? [];
  } catch {
    return [];
  }
}

function renderResults(scan: ScanResult, isWebsite = false) {
  const score = scan.healthScore.overallScore;
  document.getElementById('overall-score')!.textContent = String(score);
  document.getElementById('score-verdict')!.textContent = scoreVerdict(score);
  setScoreRing(score);

  document.getElementById('results-url')!.textContent = scan.url;

  const metaEl = document.getElementById('results-meta')!;
  const progress = (scan as ScanResult & { progress?: ScanStatusResponse['progress'] }).progress;
  if (isWebsite && progress) {
    metaEl.textContent = `${progress.completedPages} page${progress.completedPages === 1 ? '' : 's'} scanned`;
    metaEl.classList.remove('hidden');
  } else {
    metaEl.classList.add('hidden');
  }

  const categoryEl = document.getElementById('category-scores')!;
  categoryEl.innerHTML = '';

  for (const [key, data] of Object.entries(scan.healthScore.categories)) {
    const row = document.createElement('div');
    row.className = 'category-row';
    row.innerHTML = `<span>${CATEGORY_LABELS[key] ?? key}</span><span>${data.score}</span>`;
    categoryEl.appendChild(row);
  }

  document.getElementById('count-critical')!.textContent = String(scan.summary.critical);
  document.getElementById('count-high')!.textContent = String(scan.summary.high);
  document.getElementById('count-medium')!.textContent = String(scan.summary.medium);
  document.getElementById('count-low')!.textContent = String(scan.summary.low);
  document.getElementById('total-issues-label')!.textContent =
    `${scan.summary.totalIssues} total issue${scan.summary.totalIssues === 1 ? '' : 's'}`;

  const dashboardLink = document.getElementById('dashboard-link') as HTMLAnchorElement;
  dashboardLink.href = `${DASHBOARD_BASE}${scan.scanId}?fresh=1`;

  const listEl = document.getElementById('issues-list')!;
  listEl.innerHTML = '';

  const sorted = [...scan.issues].sort((a, b) => {
    const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const aKey = a.severity.toUpperCase() as keyof typeof order;
    const bKey = b.severity.toUpperCase() as keyof typeof order;
    return (order[aKey] ?? 4) - (order[bKey] ?? 4);
  });

  const preview = sorted.slice(0, 5);
  if (preview.length === 0) {
    const empty = document.createElement('p');
    empty.style.fontSize = '11px';
    empty.style.color = 'var(--text-secondary)';
    empty.style.textAlign = 'center';
    empty.style.padding = '8px';
    empty.textContent = 'No issues detected.';
    listEl.appendChild(empty);
  }

  for (const issue of preview) {
    const card = document.createElement('div');
    card.className = `issue-card ${issue.severity.toLowerCase()}`;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    const affected =
      'affectedPages' in issue && Array.isArray(issue.affectedPages) && issue.affectedPages.length > 0
        ? `<div class="meta">${issue.affectedPages.length} page(s) affected</div>`
        : '';
    card.innerHTML = `
      <h4>${escapeHtml(issue.title)}</h4>
      <div class="meta">${issue.severity} · ${issue.category}</div>
      ${affected}
    `;
    card.addEventListener('click', () => showIssueDetail(issue.id));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        showIssueDetail(issue.id);
      }
    });
    listEl.appendChild(card);
  }
}

function showIssueDetail(issueId: string) {
  if (!currentScan) return;
  const issue = currentScan.issues.find((i) => i.id === issueId);
  if (!issue) return;

  selectedIssueId = issueId;

  document.getElementById('issue-title')!.textContent = issue.title;
  const severityEl = document.getElementById('issue-severity')!;
  severityEl.textContent = issue.severity;
  severityEl.className = `severity-pill ${issue.severity.toLowerCase()}`;
  document.getElementById('issue-category')!.textContent = issue.category;
  document.getElementById('issue-problem')!.textContent = issue.problem;
  document.getElementById('issue-cause')!.textContent = issue.cause;
  document.getElementById('issue-impact')!.textContent = issue.impact;
  document.getElementById('issue-fix')!.textContent = issue.suggestedFix;
  document.getElementById('issue-evidence')!.textContent = JSON.stringify(issue.evidence, null, 2);
  document.getElementById('issue-source')!.textContent =
    `${issue.source} · ${(issue.confidence * 100).toFixed(0)}% confidence`;
  document.getElementById('ask-response')!.textContent = '';
  (document.getElementById('ask-input') as HTMLInputElement).value = '';

  showView('issue-detail');
}

async function askAi() {
  if (!currentScan || !selectedIssueId) return;
  const issue = currentScan.issues.find((i) => i.id === selectedIssueId);
  if (!issue) return;

  const question =
    (document.getElementById('ask-input') as HTMLInputElement).value.trim() || 'Why is this happening?';

  const responseEl = document.getElementById('ask-response')!;
  responseEl.textContent = 'Thinking…';

  try {
    const response = await fetch(`${API_BASE}/ai/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, url: currentScan.url, issue }),
    });

    const data = await response.json();
    responseEl.textContent = data.answer ?? 'AI explanation unavailable.';

    if (!data.aiAvailable) {
      responseEl.textContent += ' (Deterministic fallback — AI unavailable)';
    }
  } catch {
    responseEl.textContent = 'AI explanation unavailable.';
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function loadLastScanPreview() {
  const section = document.getElementById('last-scan-section')!;
  const empty = document.getElementById('empty-scan-section')!;
  const link = document.getElementById('resume-scan-link') as HTMLAnchorElement;

  const activeScan = await refreshScanStateFromBackground();
  if (activeScan && isInProgressStatus(activeScan.status)) {
    section.classList.add('hidden');
    empty.classList.add('hidden');
    return;
  }

  const stored = await chrome.storage.local.get(['lastScanId', 'lastScanAt', 'lastUrl']);
  const scanId = stored.lastScanId as string | undefined;

  if (!scanId) {
    section.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/scans/${scanId}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      section.classList.add('hidden');
      empty.classList.remove('hidden');
      return;
    }

    const scan = (await res.json()) as ScanResult;
    document.getElementById('last-scan-host')!.textContent = parseHostname(scan.url);
    document.getElementById('last-scan-date')!.textContent = formatDate(scan.scannedAt);
    document.getElementById('last-scan-score')!.textContent = String(scan.healthScore.overallScore);
    document.getElementById('last-scan-issues')!.textContent = String(scan.summary.totalIssues);

    link.href = `${DASHBOARD_BASE}${scanId}`;

    section.classList.remove('hidden');
    empty.classList.add('hidden');
  } catch {
    section.classList.add('hidden');
    empty.classList.remove('hidden');
  }
}

function toggleManualUrlsField() {
  const method = (document.getElementById('discovery-method') as HTMLSelectElement).value;
  document.getElementById('manual-urls-group')!.classList.toggle('hidden', method !== 'MANUAL');
}

function goHome() {
  stopPopupPolling();
  showView('initial');
  void loadLastScanPreview();
  void loadComponentJobPreview();
}

async function scanAgain() {
  stopPopupPolling();
  await sendRuntimeMessage({ type: 'CLEAR_ACTIVE_SCAN' });
  currentScan = null;
  goHome();
}

/**
 * "Try again" / "Back" on the error view. goHome() alone only switches which
 * view is showing — it never touches the persisted activeScan record, so a
 * FAILED/CANCELLED scan stayed in chrome.storage.local forever, and the very
 * next time the popup opened, restoreScanStateOnOpen() -> applyActiveScanToUI()
 * read that same record and called setError() again, re-showing this exact
 * screen. Reloading the extension in chrome://extensions never helped either,
 * since that only reloads the code — it doesn't clear storage. Dismissing the
 * error must clear the record itself (same as scanAgain() already does from
 * the results view), or the error is permanently sticky across every future
 * popup open until a brand-new scan happens to overwrite it.
 *
 * This view is shared by scan failures AND responsive-test failures (both
 * route through setError()) — clearing only CLEAR_ACTIVE_SCAN would leave a
 * FAILED activeResponsiveTest record exactly as sticky as the scan bug this
 * comment describes, so both are cleared here regardless of which one
 * actually caused the error (clearing the one that didn't is harmless).
 */
async function dismissError() {
  await sendRuntimeMessage({ type: 'CLEAR_ACTIVE_SCAN' });
  await sendRuntimeMessage({ type: 'CLEAR_RESPONSIVE_TEST' });
  goHome();
}

let componentPollTimer: ReturnType<typeof setInterval> | null = null;

function dashboardOrigin(): string {
  return DASHBOARD_BASE.replace(/\/scans\/?$/, '') || 'http://localhost:5173';
}

function componentStatusLabel(status: PersistedComponentJob['status']): string {
  switch (status) {
    case 'QUEUED':
      return 'Queued…';
    case 'RUNNING':
      return 'Generating code…';
    case 'COMPLETED':
      return 'Ready';
    case 'BLOCKED_PRIVACY':
      return 'Blocked — sensitive content';
    case 'FAILED':
      return 'Failed';
    default:
      return status;
  }
}

function renderComponentJob(job: PersistedComponentJob | null) {
  const section = document.getElementById('component-job-section')!;
  if (!job) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  document.getElementById('component-job-name')!.textContent =
    job.componentName ?? (job.status === 'FAILED' || job.status === 'BLOCKED_PRIVACY' ? 'Generation issue' : 'Generating component…');
  document.getElementById('component-job-status')!.textContent = componentStatusLabel(job.status);

  const link = document.getElementById('component-job-link') as HTMLAnchorElement;
  link.href = `${dashboardOrigin()}/components/${job.jobId}`;
  link.textContent = isComponentJobTerminal(job.status) ? 'View in dashboard' : 'Track progress';
}

async function refreshComponentJobFromBackground(): Promise<PersistedComponentJob | null> {
  const response = await sendRuntimeMessage<{ activeJob?: PersistedComponentJob | null }>({
    type: 'GET_COMPONENT_JOB_STATE',
  });
  return response.activeJob ?? null;
}

function stopComponentPolling() {
  if (componentPollTimer) {
    clearInterval(componentPollTimer);
    componentPollTimer = null;
  }
}

function startComponentPolling() {
  stopComponentPolling();
  const poll = async () => {
    const job = await refreshComponentJobFromBackground();
    renderComponentJob(job);
    if (!job || isComponentJobTerminal(job.status)) stopComponentPolling();
  };
  void poll();
  componentPollTimer = setInterval(poll, 3000);
}

async function loadComponentJobPreview() {
  const job = await refreshComponentJobFromBackground();
  renderComponentJob(job);
  if (job && isComponentJobInProgress(job.status)) startComponentPolling();
}

/** Enters "Select Anything" mode on the current tab — the SAME flow whether entered via the "Select Element" card (Explain/Fix/Improve/Make Responsive/Convert.../Recreate Component) or the "Screenshot → Code" card (just a different immediate framing of the same underlying capability). */
async function startElementSelectionFlow() {
  const health = await checkBackendHealth();
  if (!health.ok) {
    setError(health.message ?? 'Backend unavailable.');
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) {
    setError('No active tab found.');
    return;
  }
  if (isRestrictedUrl(tab.url)) {
    setError('Cannot select on restricted Chrome pages. Open a regular webpage.');
    return;
  }

  const response = await sendRuntimeMessage<{ success: boolean; error?: string }>({
    type: 'START_ELEMENT_SELECTION',
    tabId: tab.id,
  });

  if (!response.success) {
    setError(response.error ?? 'Could not enter selection mode on this page.');
    return;
  }

  // Selection happens on the page itself — get out of the way so the user can draw it.
  window.close();
}

/* ------------------------------------------------------------------------ */
/* Test Responsive                                                          */
/* ------------------------------------------------------------------------ */

let currentResponsiveResult: ResponsiveTestResult | null = null;
let selectedResponsiveIssue: Issue | null = null;
let responsiveTestToken = 0;

function responsiveWidthLabel(width: number, isLast: boolean): string {
  return isLast ? 'Desktop' : `${width}px`;
}

function setLensBanner(id: string, kind: 'active' | 'event' | 'alert', text: string) {
  const el = document.getElementById(id)!;
  el.className = `lens-banner ${kind}`;
  el.textContent = text;
  el.classList.remove('hidden');
}

function renderResponsiveProgressList(url: string) {
  document.getElementById('responsive-progress-url')!.textContent = url;
  setLensBanner('lens-banner-responsive-progress', 'active', 'Lens Active: Testing responsive layouts…');

  const listEl = document.getElementById('responsive-progress-list')!;
  listEl.innerHTML = '';
  const widths = [...DEFAULT_RESPONSIVE_WIDTHS];
  widths.forEach((width, i) => {
    const li = document.createElement('li');
    li.className = 'active';
    li.innerHTML = `<span class="step-icon"></span>${responsiveWidthLabel(width, i === widths.length - 1)} — Testing…`;
    listEl.appendChild(li);
  });
}

/**
 * Bugfix: "Test Responsive" used to be a bare in-popup request/response
 * lasting up to ~130s (six real Playwright viewport renders) with NO
 * persisted state — Chrome closes an action popup on blur (trivial for a
 * real user to trigger while waiting), which silently destroyed the whole
 * in-flight test: reopening showed the plain home view, indistinguishable
 * from the button doing nothing. The background coordinator
 * (responsive-test-coordinator.ts) now persists RUNNING/COMPLETED/FAILED/
 * CANCELLED to chrome.storage.local — this function still awaits the direct
 * response for the common case (popup stays open), but init()'s
 * restoreResponsiveTestStateOnOpen + the storage.onChanged listener below
 * are what make it survive a close/reopen in between.
 */
async function startResponsiveTest() {
  const health = await checkBackendHealth();
  if (!health.ok) {
    setError(health.message ?? 'Backend unavailable.');
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.url) {
    setError('No active tab found.');
    return;
  }
  if (isRestrictedUrl(tab.url)) {
    setError('Cannot test responsive layouts on restricted Chrome pages. Open a regular webpage.');
    return;
  }

  const token = ++responsiveTestToken;
  const url = tab.url;

  renderResponsiveProgressList(url);
  showView('responsive-progress');

  const response = await sendRuntimeMessage<ResponsiveTestMessageResponse>({
    type: 'RUN_RESPONSIVE_TEST',
    url,
  });

  // The user backed out or started a different test while this one was in
  // flight — never clobber whatever view/state they've since moved to. (If
  // the WHOLE POPUP closed instead, this code never runs at all — recovery
  // for that case is restoreResponsiveTestStateOnOpen/storage.onChanged.)
  if (token !== responsiveTestToken) return;

  if (!response.ok || !response.result) {
    if (response.errorCode === 'CANCELLED') return; // already handled by cancelResponsiveTest's own navigation
    setLensBanner('lens-banner-responsive-progress', 'alert', 'Lens Alert: Unable to test this page.');
    setError(response.error ?? 'Responsive test failed.', response.errorCode);
    return;
  }

  currentResponsiveResult = response.result;
  renderResponsiveResults(response.result);
  showView('responsive-results');
}

/** "Cancel Test" — actually tells the background to abort the in-flight request (see cancelResponsiveTest in responsive-test-coordinator.ts), not just a local navigation away that leaves an orphaned request running. */
async function cancelResponsiveTest() {
  responsiveTestToken++; // invalidate any in-flight request's result in THIS popup instance
  await sendRuntimeMessage({ type: 'CANCEL_RESPONSIVE_TEST' });
  goHome();
}

/** Mirrors applyActiveScanToUI's job for the persisted responsive-test record — called both on popup init (restoreResponsiveTestStateOnOpen) and live, via the storage.onChanged listener in init(), so a test that finishes WHILE the popup happens to be open also updates it immediately. */
function applyActiveResponsiveTestToUI(test: PersistedResponsiveTest): void {
  if (test.status === 'RUNNING') {
    renderResponsiveProgressList(test.url);
    showView('responsive-progress');
    return;
  }
  if (test.status === 'COMPLETED' && test.result) {
    currentResponsiveResult = test.result;
    renderResponsiveResults(test.result);
    showView('responsive-results');
    return;
  }
  if (test.status === 'FAILED') {
    setLensBanner('lens-banner-responsive-progress', 'alert', 'Lens Alert: Unable to test this page.');
    setError(test.error ?? 'Responsive test failed.', test.errorCode);
  }
  // CANCELLED: no view change — same as a normal "Cancel Test" click already handled.
}

async function restoreResponsiveTestStateOnOpen(): Promise<void> {
  const response = await sendRuntimeMessage<{ activeTest: PersistedResponsiveTest | null }>({ type: 'GET_RESPONSIVE_TEST_STATE' });
  const activeTest = response.activeTest;
  if (!activeTest) return;

  // A RUNNING test is worth resuming regardless of which tab is active now
  // (it keeps running in the background either way) — but a finished result
  // should only take over the popup's main view when it's for the page
  // you're currently on, same rule restoreScanStateOnOpen already applies.
  if (activeTest.status !== 'RUNNING') {
    const tab = await getActiveTab();
    if (tab?.url !== activeTest.url) return;
  }

  applyActiveResponsiveTestToUI(activeTest);
}

function renderResponsiveResults(result: ResponsiveTestResult) {
  document.getElementById('responsive-results-url')!.textContent = result.url;

  const totalIssues = result.viewports.reduce((sum, v) => sum + v.issueCount, 0);
  document.getElementById('responsive-results-summary')!.textContent =
    totalIssues === 0 ? 'No responsive issues found.' : `${totalIssues} issue${totalIssues === 1 ? '' : 's'} found`;

  setLensBanner(
    'lens-banner-responsive-results',
    totalIssues === 0 ? 'event' : 'alert',
    totalIssues === 0 ? 'Lens Event: Responsive testing completed.' : 'Lens Alert: Responsive issues found.',
  );

  const listEl = document.getElementById('responsive-viewport-list')!;
  listEl.innerHTML = '';

  result.viewports.forEach((viewport) => {
    const li = document.createElement('li');
    const hasIssues = viewport.issueCount > 0;

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'responsive-viewport-row';
    row.disabled = !hasIssues;
    row.innerHTML = `
      <span class="page-status-icon">${hasIssues ? '⚠' : '✓'}</span>
      <span class="responsive-viewport-label">${escapeHtml(viewport.label)}</span>
      <span class="responsive-viewport-count ${hasIssues ? 'has-issues' : 'ok'}">${hasIssues ? `${viewport.issueCount} issue${viewport.issueCount === 1 ? '' : 's'}` : 'No issues'}</span>
    `;
    li.className = hasIssues ? 'failed' : 'done';
    li.appendChild(row);

    if (hasIssues) {
      const issuesEl = document.createElement('div');
      issuesEl.className = 'responsive-viewport-issues hidden';
      for (const issue of viewport.issues) {
        const card = document.createElement('div');
        card.className = `issue-card ${issue.severity.toLowerCase()}`;
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        card.innerHTML = `<h4>${escapeHtml(issue.title)}</h4><div class="meta">${issue.severity}</div>`;
        card.addEventListener('click', () => showResponsiveIssueDetail(viewport, issue));
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            showResponsiveIssueDetail(viewport, issue);
          }
        });
        issuesEl.appendChild(card);
      }
      li.appendChild(issuesEl);
      row.addEventListener('click', () => issuesEl.classList.toggle('hidden'));
    }

    listEl.appendChild(li);
  });
}

function showResponsiveIssueDetail(viewport: ResponsiveViewportResult, issue: Issue) {
  selectedResponsiveIssue = issue;

  document.getElementById('responsive-issue-title')!.textContent = issue.title;
  const severityEl = document.getElementById('responsive-issue-severity')!;
  severityEl.textContent = issue.severity;
  severityEl.className = `severity-pill ${issue.severity.toLowerCase()}`;
  document.getElementById('responsive-issue-viewport')!.textContent = viewport.label;
  document.getElementById('responsive-issue-problem')!.textContent = issue.problem;
  document.getElementById('responsive-issue-cause')!.textContent = issue.cause;
  document.getElementById('responsive-issue-fix')!.textContent = issue.suggestedFix;
  document.getElementById('responsive-issue-status')!.textContent = '';
  document.getElementById('responsive-issue-explain-response')!.textContent = '';

  const screenshotEl = document.getElementById('responsive-issue-screenshot') as HTMLImageElement;
  if (viewport.screenshotBase64) {
    screenshotEl.src = `data:image/jpeg;base64,${viewport.screenshotBase64}`;
    screenshotEl.classList.remove('hidden');
  } else {
    screenshotEl.classList.add('hidden');
  }

  const selector = issue.evidence.selector;
  const selectorCard = document.getElementById('responsive-issue-selector-card')!;
  const selectBtn = document.getElementById('responsive-issue-select-btn') as HTMLButtonElement;
  const fixBtn = document.getElementById('responsive-issue-fix-btn') as HTMLButtonElement;
  if (selector) {
    document.getElementById('responsive-issue-selector')!.textContent = selector;
    selectorCard.classList.remove('hidden');
    selectBtn.disabled = false;
    fixBtn.disabled = false;
  } else {
    selectorCard.classList.add('hidden');
    selectBtn.disabled = true;
    fixBtn.disabled = true;
  }

  showView('responsive-issue-detail');
}

async function explainResponsiveIssue() {
  if (!currentResponsiveResult || !selectedResponsiveIssue) return;
  const responseEl = document.getElementById('responsive-issue-explain-response')!;
  responseEl.textContent = 'Thinking…';

  try {
    const response = await fetch(`${API_BASE}/ai/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Explain this responsive layout issue in detail: why it happens and exactly how to fix it.',
        url: currentResponsiveResult.url,
        issue: selectedResponsiveIssue,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    responseEl.textContent = data.answer ?? 'AI explanation unavailable.';
  } catch {
    responseEl.textContent = 'AI explanation unavailable.';
  }
}

async function selectResponsiveIssueElement(autoAction?: 'fix') {
  const selector = selectedResponsiveIssue?.evidence.selector;
  const statusEl = document.getElementById('responsive-issue-status')!;
  if (!selector) return;

  const tab = await getActiveTab();
  if (!tab?.id) {
    statusEl.textContent = 'Lens Alert: No active tab found.';
    return;
  }

  statusEl.textContent = autoAction
    ? 'Lens Active: Selecting element and running Fix…'
    : 'Lens Active: Selecting element on the page…';

  const response = await sendRuntimeMessage<{ success: boolean; error?: string }>({
    type: 'SELECT_ELEMENT_BY_SELECTOR',
    tabId: tab.id,
    selector,
    autoAction,
  });

  if (!response.success) {
    statusEl.textContent = `Lens Alert: ${response.error ?? 'Could not select this element on the page.'}`;
    return;
  }

  // Selection (and any auto-triggered action) happens on the page itself,
  // in the Selected Element panel — get out of the way so the user sees it.
  window.close();
}

/* ------------------------------------------------------------------------ */
/* Report a Bug                                                             */
/* ------------------------------------------------------------------------ */

let bugReportResultUrl = '';

async function openBugReportForm() {
  const tab = await getActiveTab();
  if (!tab?.url) {
    setError('No active tab found.');
    return;
  }
  if (isRestrictedUrl(tab.url)) {
    setError('Cannot report a bug on restricted Chrome pages. Open a regular webpage.');
    return;
  }

  document.getElementById('bug-report-url')!.textContent = tab.url;
  (document.getElementById('bug-report-form') as HTMLFormElement).reset();
  document.getElementById('bug-report-form-error')!.classList.add('hidden');
  showView('bug-report-form');
}

async function submitBugReport(e: SubmitEvent) {
  e.preventDefault();
  const submitBtn = document.getElementById('bug-report-submit-btn') as HTMLButtonElement;
  const errorEl = document.getElementById('bug-report-form-error')!;
  errorEl.classList.add('hidden');

  const tab = await getActiveTab();
  if (!tab?.id) {
    setError('No active tab found.');
    return;
  }

  const title = (document.getElementById('bug-report-title') as HTMLInputElement).value.trim();
  const description = (document.getElementById('bug-report-description') as HTMLTextAreaElement).value.trim();
  if (!title || !description) {
    errorEl.textContent = 'Title and description are required.';
    errorEl.classList.remove('hidden');
    return;
  }

  const steps = (document.getElementById('bug-report-steps') as HTMLTextAreaElement).value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const form: BugReportFormInput = {
    title,
    description,
    severity: (document.getElementById('bug-report-severity') as HTMLSelectElement).value as Severity,
    category: (document.getElementById('bug-report-category') as HTMLSelectElement).value as IssueCategory,
    reproductionSteps: steps,
    expectedBehavior: (document.getElementById('bug-report-expected') as HTMLInputElement).value.trim() || undefined,
    actualBehavior: (document.getElementById('bug-report-actual') as HTMLInputElement).value.trim() || undefined,
  };

  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating…';
  try {
    const response = await sendRuntimeMessage<CreateBugReportMessageResponse>({
      type: 'CREATE_BUG_REPORT',
      tabId: tab.id,
      form,
    });

    if (!response.ok || !response.result) {
      errorEl.textContent = `Lens Alert: ${response.error ?? 'Could not create the bug report.'}`;
      errorEl.classList.remove('hidden');
      return;
    }

    bugReportResultUrl = response.result.url;
    (document.getElementById('bug-report-view-link') as HTMLAnchorElement).href = bugReportResultUrl;
    showView('bug-report-result');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Bug Report';
  }
}

async function init() {
  const tab = await getActiveTab();
  if (tab?.url && !isRestrictedUrl(tab.url)) {
    updateCurrentSiteDisplay(tab.url);
  } else if (tab?.url) {
    updateCurrentSiteDisplay('Restricted page');
  }

  const dashboardBase = DASHBOARD_BASE.replace(/\/scans\/?$/, '') || 'http://localhost:5173';
  (document.getElementById('header-dashboard-link') as HTMLAnchorElement).href = dashboardBase;

  document.getElementById('current-page-btn')!.addEventListener('click', startCurrentPageScan);
  document.getElementById('website-btn')!.addEventListener('click', showWebsiteConfig);
  document.getElementById('screenshot-to-code-btn')!.addEventListener('click', startElementSelectionFlow);
  document.getElementById('select-element-btn')!.addEventListener('click', startElementSelectionFlow);
  document.getElementById('test-responsive-btn')!.addEventListener('click', () => void startResponsiveTest());
  document.getElementById('responsive-progress-cancel-btn')!.addEventListener('click', cancelResponsiveTest);
  document.getElementById('responsive-results-back-btn')!.addEventListener('click', goHome);
  document.getElementById('responsive-test-again-btn')!.addEventListener('click', () => void startResponsiveTest());
  document.getElementById('responsive-issue-back-btn')!.addEventListener('click', () => showView('responsive-results'));
  document.getElementById('responsive-issue-explain-btn')!.addEventListener('click', () => void explainResponsiveIssue());
  document.getElementById('responsive-issue-select-btn')!.addEventListener('click', () => void selectResponsiveIssueElement());
  document.getElementById('responsive-issue-fix-btn')!.addEventListener('click', () => void selectResponsiveIssueElement('fix'));
  document.getElementById('report-bug-btn')!.addEventListener('click', () => void openBugReportForm());
  document.getElementById('bug-report-back-btn')!.addEventListener('click', goHome);
  document.getElementById('bug-report-form')!.addEventListener('submit', (e) => void submitBugReport(e));
  document.getElementById('bug-report-done-btn')!.addEventListener('click', goHome);
  document.getElementById('website-form')!.addEventListener('submit', startWebsiteScan);
  document.getElementById('website-back-btn')!.addEventListener('click', goHome);
  document.getElementById('discovery-method')!.addEventListener('change', toggleManualUrlsField);
  document.getElementById('retry-btn')!.addEventListener('click', () => void dismissError());
  document.getElementById('error-back-btn')!.addEventListener('click', () => void dismissError());
  // Real <a href target="_blank"> — the click still navigates natively;
  // this only clears the stuck error state so re-opening the popup later
  // doesn't show it again (same reason retry-btn/error-back-btn do this).
  document.getElementById('view-plans-btn')!.addEventListener('click', () => void dismissError());
  document.getElementById('auth-sign-in-btn')!.addEventListener('click', () => void dismissError());
  document.getElementById('auth-back-btn')!.addEventListener('click', () => void dismissError());
  document.getElementById('scan-again-btn')!.addEventListener('click', scanAgain);
  document.getElementById('issue-back-btn')!.addEventListener('click', () => showView('results'));
  document.getElementById('ask-btn')!.addEventListener('click', askAi);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.activeScan) {
      const activeScan = changes.activeScan.newValue as PersistedActiveScan | undefined;
      if (activeScan) void applyActiveScanToUI(activeScan);
    }
    // Live-updates the CURRENTLY OPEN popup the moment a responsive test
    // finishes in the background — the same mechanism that makes it survive
    // a close/reopen (see restoreResponsiveTestStateOnOpen) also covers the
    // "popup stayed open the whole time" case, so both paths go through one
    // source of truth instead of two.
    if (changes[RESPONSIVE_TEST_STORAGE_KEY]) {
      const activeTest = changes[RESPONSIVE_TEST_STORAGE_KEY].newValue as PersistedResponsiveTest | undefined;
      if (activeTest) applyActiveResponsiveTestToUI(activeTest);
    }
  });

  await restoreScanStateOnOpen();
  await restoreResponsiveTestStateOnOpen();
  await loadLastScanPreview();
  await loadComponentJobPreview();
}

init();
