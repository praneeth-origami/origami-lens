/// <reference types="chrome" />

export const STORAGE_KEYS = {
  ACTIVE_SCAN: 'activeScan',
} as const;

export interface ScanProgress {
  discoveredPages: number;
  completedPages: number;
  failedPages: number;
  issuesFound: number;
}

export interface PersistedActiveScan {
  scanId: string;
  scanType: 'WEBSITE' | 'CURRENT_PAGE';
  targetUrl: string;
  status: string;
  progress: ScanProgress;
  startedAt: string;
  updatedAt: string;
  error?: string;
  healthScore?: number;
  totalIssues?: number;
  /** Consecutive failed status-poll attempts (network error or non-2xx response) — see scan-coordinator.ts's refreshActiveScanFromBackend. Resets to 0 on any successful poll. Bounds how long a scan can appear to be "still running" when the backend is actually unreachable or erroring, instead of polling silently forever. */
  pollFailureCount?: number;
}

export const TERMINAL_SCAN_STATUSES = [
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS',
  'FAILED',
  'CANCELLED',
] as const;

export function isInProgressStatus(status: string): boolean {
  return status === 'QUEUED' || status === 'RUNNING' || status === 'PENDING';
}

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_SCAN_STATUSES as readonly string[]).includes(status);
}

export async function getActiveScan(): Promise<PersistedActiveScan | null> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_SCAN);
  const scan = data[STORAGE_KEYS.ACTIVE_SCAN] as PersistedActiveScan | undefined;
  return scan ?? null;
}

export async function setActiveScan(scan: PersistedActiveScan | null): Promise<void> {
  if (scan) {
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_SCAN]: scan });
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.ACTIVE_SCAN);
  }
}

export async function saveLastScanMeta(meta: {
  scanId: string;
  url: string;
  scannedAt: string;
}): Promise<void> {
  await chrome.storage.local.set({
    lastScanId: meta.scanId,
    lastScanAt: meta.scannedAt,
    lastUrl: meta.url,
  });
}
