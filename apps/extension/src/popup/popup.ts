import { API_BASE, DASHBOARD_BASE, type ScanResult } from '../types/scan.js';
import type { PersistedActiveScan } from '../shared/scan-storage.js';
import { isInProgressStatus, isTerminalStatus } from '../shared/scan-storage.js';
import type { StartScanResponse } from '../shared/messages.js';
import type { PersistedComponentJob } from '../shared/component-storage.js';
import { isComponentJobInProgress, isComponentJobTerminal } from '../shared/component-storage.js';

type ViewId =
  | 'initial'
  | 'website-config'
  | 'scanning'
  | 'website-progress'
  | 'results'
  | 'issue-detail'
  | 'error';

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
  error: document.getElementById('view-error')!,
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

function friendlyError(raw: string): { title: string; body: string; detail?: string } {
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

function setError(message: string) {
  const err = friendlyError(message);
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
  showView('error');
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
      setError(activeScan.error ?? 'Website scan failed.');
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
      setError(activeScan.error ?? 'Page scan failed.');
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

  const result = await sendRuntimeMessage<{ ok: boolean; scan?: ScanResult; error?: string }>({
    type: 'START_CURRENT_PAGE_SCAN',
    targetUrl,
    pageEvidence: pageEvidence.evidence,
  });

  await stepsPromise;
  stopPopupPolling();

  if (!result.ok) {
    setError(result.error ?? 'Scan failed.');
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
    setError(result.error ?? 'Failed to start website scan.');
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
 */
async function dismissError() {
  await sendRuntimeMessage({ type: 'CLEAR_ACTIVE_SCAN' });
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

async function startScreenshotToCode() {
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
  document.getElementById('screenshot-to-code-btn')!.addEventListener('click', startScreenshotToCode);
  document.getElementById('website-form')!.addEventListener('submit', startWebsiteScan);
  document.getElementById('website-back-btn')!.addEventListener('click', goHome);
  document.getElementById('discovery-method')!.addEventListener('change', toggleManualUrlsField);
  document.getElementById('retry-btn')!.addEventListener('click', () => void dismissError());
  document.getElementById('error-back-btn')!.addEventListener('click', () => void dismissError());
  document.getElementById('scan-again-btn')!.addEventListener('click', scanAgain);
  document.getElementById('issue-back-btn')!.addEventListener('click', () => showView('results'));
  document.getElementById('ask-btn')!.addEventListener('click', askAi);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.activeScan) return;
    const activeScan = changes.activeScan.newValue as PersistedActiveScan | undefined;
    if (!activeScan) return;
    void applyActiveScanToUI(activeScan);
  });

  await restoreScanStateOnOpen();
  await loadLastScanPreview();
  await loadComponentJobPreview();
}

init();
