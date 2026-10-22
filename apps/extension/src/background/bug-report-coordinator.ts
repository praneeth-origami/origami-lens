/// <reference types="chrome" />

import { API_BASE } from '../types/scan.js';
import type { BugReportFormInput, CreateBugReportMessageResponse } from '../shared/messages.js';
import type { ConsoleEntry, CreateBugReportRequest, NetworkEntry } from '@origami/contracts';
import { ensureContentScript } from './content-script-utils.js';

interface CollectedEvidence {
  url: string;
  pageTitle: string;
  browser: string;
  operatingSystem: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  screenshotBase64: string;
  domEvidence?: CreateBugReportRequest['domEvidence'];
}

function sendToTab<T>(tabId: number, message: unknown): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) resolve(undefined);
      else resolve(response as T);
    });
  });
}

/**
 * Create Bug Report — orchestrates the two content-script captures
 * (selection-overlay.ts's local evidence via content-script.ts, and
 * bug-report-monitor.ts's buffered console/network errors) and the API
 * call, mirroring every other coordinator's shape (scan-coordinator.ts,
 * responsive-test-coordinator.ts). Console/network capture is best-effort —
 * a tab that predates the extension's install/reload never got
 * bug-report-monitor.ts injected and simply contributes empty arrays rather
 * than failing the whole report.
 */
export async function createBugReport(tabId: number, form: BugReportFormInput): Promise<CreateBugReportMessageResponse> {
  await ensureContentScript(tabId);

  const evidenceResponse = await sendToTab<{ success: boolean; result?: CollectedEvidence | { blockReason: string }; error?: string }>(
    tabId,
    { type: 'COLLECT_BUG_REPORT_EVIDENCE' },
  );

  if (!evidenceResponse?.success || !evidenceResponse.result) {
    return { ok: false, error: evidenceResponse?.error ?? 'Could not capture evidence from this page.' };
  }
  if ('blockReason' in evidenceResponse.result) {
    return { ok: false, error: `Cannot report a bug for this selection: it contains ${evidenceResponse.result.blockReason}.` };
  }
  const evidence = evidenceResponse.result;

  const context = await sendToTab<{ consoleErrors: ConsoleEntry[]; networkErrors: NetworkEntry[] }>(tabId, { type: 'GET_BUG_REPORT_CONTEXT' });

  const body: CreateBugReportRequest = {
    title: form.title,
    url: evidence.url,
    pageTitle: evidence.pageTitle,
    browser: evidence.browser,
    operatingSystem: evidence.operatingSystem,
    viewportWidth: evidence.viewportWidth,
    viewportHeight: evidence.viewportHeight,
    devicePixelRatio: evidence.devicePixelRatio,
    screenshotBase64: evidence.screenshotBase64 || undefined,
    consoleErrors: context?.consoleErrors ?? [],
    networkErrors: context?.networkErrors ?? [],
    domEvidence: evidence.domEvidence,
    description: form.description,
    severity: form.severity,
    category: form.category,
    reproductionSteps: form.reproductionSteps,
    expectedBehavior: form.expectedBehavior,
    actualBehavior: form.actualBehavior,
  };

  try {
    const response = await fetch(`${API_BASE}/bug-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const { error: message = `Could not create the bug report (${response.status}).`, errorCode } = err as { error?: string; errorCode?: string };
      return { ok: false, error: message, errorCode };
    }

    const result = (await response.json()) as import('@origami/contracts').CreateBugReportResponse;
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to reach the Origami API.' };
  }
}
