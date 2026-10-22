/// <reference types="chrome" />

import type { ResponsiveTestResult } from '@origami/contracts';

export const RESPONSIVE_TEST_STORAGE_KEY = 'activeResponsiveTest';

export type ResponsiveTestStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/**
 * Persisted the same way scan-storage.ts persists PersistedActiveScan — the
 * root cause of "Test Responsive doesn't actually work" was that this
 * feature had NO such persistence: it was a bare in-popup request/response
 * lasting up to ~130s (six real Playwright viewport renders). Chrome closes
 * an action popup on blur — trivially easy for a real user to trigger while
 * waiting — which killed the in-flight state with nothing left behind:
 * reopening the popup showed the plain home view, indistinguishable from the
 * button doing nothing. Every OTHER long-running extension operation (Scan
 * Page, Website Scan, Component Generation) persists to chrome.storage.local
 * from the BACKGROUND coordinator (which keeps running after the popup
 * closes) precisely so it survives this. This gives Responsive Testing the
 * same guarantee.
 */
export interface PersistedResponsiveTest {
  url: string;
  status: ResponsiveTestStatus;
  startedAt: string;
  updatedAt: string;
  result?: ResponsiveTestResult;
  error?: string;
  errorCode?: string;
}

export function isResponsiveTestInProgress(status: ResponsiveTestStatus): boolean {
  return status === 'RUNNING';
}

export async function getActiveResponsiveTest(): Promise<PersistedResponsiveTest | null> {
  const data = await chrome.storage.local.get(RESPONSIVE_TEST_STORAGE_KEY);
  const test = data[RESPONSIVE_TEST_STORAGE_KEY] as PersistedResponsiveTest | undefined;
  return test ?? null;
}

export async function setActiveResponsiveTest(test: PersistedResponsiveTest | null): Promise<void> {
  if (test) {
    await chrome.storage.local.set({ [RESPONSIVE_TEST_STORAGE_KEY]: test });
  } else {
    await chrome.storage.local.remove(RESPONSIVE_TEST_STORAGE_KEY);
  }
}
