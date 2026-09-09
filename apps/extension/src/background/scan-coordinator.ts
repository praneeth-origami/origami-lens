/// <reference types="chrome" />

import { API_BASE } from '../types/scan.js';
import type { ScanResult } from '../types/scan.js';
import type { WebsiteScanOptions } from '../shared/messages.js';
import {
  getActiveScan,
  isInProgressStatus,
  isTerminalStatus,
  saveLastScanMeta,
  setActiveScan,
  type PersistedActiveScan,
  type ScanProgress,
} from '../shared/scan-storage.js';

export const SCAN_POLL_ALARM = 'origami-scan-poll';

interface ScanStatusResponse {
  scanId: string;
  scanType: string;
  status: string;
  progress: ScanProgress;
  healthScore?: { overallScore: number };
  error?: string;
}

const emptyProgress = (): ScanProgress => ({
  discoveredPages: 0,
  completedPages: 0,
  failedPages: 0,
  issuesFound: 0,
});

function nowIso(): string {
  return new Date().toISOString();
}

async function ensurePollAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(SCAN_POLL_ALARM);
  if (!existing) {
    await chrome.alarms.create(SCAN_POLL_ALARM, { periodInMinutes: 1 });
  }
}

async function clearPollAlarm(): Promise<void> {
  await chrome.alarms.clear(SCAN_POLL_ALARM);
}

export async function refreshActiveScanFromBackend(): Promise<PersistedActiveScan | null> {
  const active = await getActiveScan();
  if (!active) return null;

  if (active.scanType === 'CURRENT_PAGE' && active.scanId === 'pending') {
    return active;
  }

  if (!active.scanId || active.scanId === 'pending') {
    return active;
  }

  try {
    const res = await fetch(`${API_BASE}/scans/${active.scanId}/status`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return active;

    const status = (await res.json()) as ScanStatusResponse;
    const updated: PersistedActiveScan = {
      ...active,
      status: status.status,
      progress: status.progress,
      updatedAt: nowIso(),
      error: status.error,
      healthScore: status.healthScore?.overallScore,
    };

    if (isTerminalStatus(status.status)) {
      await clearPollAlarm();

      if (status.status === 'FAILED' || status.status === 'CANCELLED') {
        updated.error = status.error ?? `Scan ${status.status.toLowerCase()}.`;
        await setActiveScan(updated);
        return updated;
      }

      const scanRes = await fetch(`${API_BASE}/scans/${active.scanId}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (scanRes.ok) {
        const scan = (await scanRes.json()) as ScanResult;
        updated.healthScore = scan.healthScore.overallScore;
        updated.totalIssues = scan.summary.totalIssues;
        await saveLastScanMeta({
          scanId: scan.scanId,
          url: scan.url,
          scannedAt: scan.scannedAt,
        });
      }

      await setActiveScan(updated);
      return updated;
    }

    await setActiveScan(updated);
    await ensurePollAlarm();
    return updated;
  } catch {
    return active;
  }
}

export async function pollActiveWebsiteScan(): Promise<void> {
  const active = await getActiveScan();
  if (!active || active.scanType !== 'WEBSITE') {
    await clearPollAlarm();
    return;
  }

  if (isTerminalStatus(active.status)) {
    await clearPollAlarm();
    return;
  }

  await refreshActiveScanFromBackend();
}

export async function startWebsiteScan(
  options: WebsiteScanOptions,
): Promise<{ ok: boolean; scanId?: string; error?: string }> {
  const existing = await getActiveScan();
  if (existing && isInProgressStatus(existing.status)) {
    return {
      ok: false,
      error: `A ${existing.scanType === 'WEBSITE' ? 'website' : 'page'} scan is already in progress.`,
    };
  }

  const startedAt = nowIso();
  const placeholder: PersistedActiveScan = {
    scanId: 'pending',
    scanType: 'WEBSITE',
    targetUrl: options.url,
    status: 'QUEUED',
    progress: emptyProgress(),
    startedAt,
    updatedAt: startedAt,
  };
  await setActiveScan(placeholder);

  try {
    const response = await fetch(`${API_BASE}/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: options.url,
        scanType: 'WEBSITE',
        websiteOptions: {
          discoveryMethod: options.discoveryMethod,
          maxPages: Math.min(options.maxPages, 50),
          manualUrls: options.manualUrls,
          runLighthouse: false,
          runAxe: true,
          mobileViewport: true,
          includeScreenshots: false,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const message = (err as { error?: string }).error ?? 'Failed to start website scan.';
      await setActiveScan({
        ...placeholder,
        status: 'FAILED',
        error: message,
        updatedAt: nowIso(),
      });
      return { ok: false, error: message };
    }

    const data = (await response.json()) as { scanId: string; status?: string };
    const active: PersistedActiveScan = {
      ...placeholder,
      scanId: data.scanId,
      status: data.status ?? 'QUEUED',
      updatedAt: nowIso(),
    };
    await setActiveScan(active);
    await ensurePollAlarm();
    await pollActiveWebsiteScan();

    return { ok: true, scanId: data.scanId };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to start website scan.';
    await setActiveScan({
      ...placeholder,
      status: 'FAILED',
      error: message,
      updatedAt: nowIso(),
    });
    return { ok: false, error: message };
  }
}

export async function startCurrentPageScan(
  targetUrl: string,
  pageEvidence: unknown,
): Promise<{ ok: boolean; scan?: ScanResult; error?: string }> {
  const existing = await getActiveScan();
  if (existing && isInProgressStatus(existing.status)) {
    return {
      ok: false,
      error: `A ${existing.scanType === 'WEBSITE' ? 'website' : 'page'} scan is already in progress.`,
    };
  }

  const startedAt = nowIso();
  const pending: PersistedActiveScan = {
    scanId: 'pending',
    scanType: 'CURRENT_PAGE',
    targetUrl,
    status: 'RUNNING',
    progress: emptyProgress(),
    startedAt,
    updatedAt: startedAt,
  };
  await setActiveScan(pending);

  try {
    const response = await fetch(`${API_BASE}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: targetUrl,
        scanType: 'CURRENT_PAGE',
        pageEvidence,
        options: {
          includeScreenshots: true,
          mobileViewport: true,
          runLighthouse: true,
          runAxe: true,
        },
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const message = (err as { error?: string }).error ?? `Scan failed (${response.status}).`;
      await setActiveScan({
        ...pending,
        status: 'FAILED',
        error: message,
        updatedAt: nowIso(),
      });
      return { ok: false, error: message };
    }

    const scan = (await response.json()) as ScanResult;
    await saveLastScanMeta({
      scanId: scan.scanId,
      url: scan.url,
      scannedAt: scan.scannedAt,
    });

    const completed: PersistedActiveScan = {
      scanId: scan.scanId,
      scanType: 'CURRENT_PAGE',
      targetUrl: scan.url,
      status: 'COMPLETED',
      progress: emptyProgress(),
      startedAt,
      updatedAt: nowIso(),
      healthScore: scan.healthScore.overallScore,
      totalIssues: scan.summary.totalIssues,
    };
    await setActiveScan(completed);

    return { ok: true, scan };
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? 'Scan timed out. The page may be too large or the backend is unavailable.'
        : error instanceof Error
          ? error.message
          : 'Backend unavailable.';
    await setActiveScan({
      ...pending,
      status: 'FAILED',
      error: message,
      updatedAt: nowIso(),
    });
    return { ok: false, error: message };
  }
}

export async function getScanState(): Promise<PersistedActiveScan | null> {
  const active = await getActiveScan();
  if (!active) return null;

  if (active.scanType === 'WEBSITE' && isInProgressStatus(active.status)) {
    return refreshActiveScanFromBackend();
  }

  return active;
}

export async function clearActiveScan(): Promise<void> {
  await clearPollAlarm();
  await setActiveScan(null);
}

export function registerScanAlarmListener(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SCAN_POLL_ALARM) {
      pollActiveWebsiteScan().catch(() => {});
    }
  });
}

export async function recoverScanOnStartup(): Promise<void> {
  const active = await getActiveScan();
  if (!active) return;

  if (active.scanType === 'WEBSITE' && isInProgressStatus(active.status)) {
    await ensurePollAlarm();
    await pollActiveWebsiteScan();
  }
}
