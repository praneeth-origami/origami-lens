/// <reference types="chrome" />

import { API_BASE } from '../types/scan.js';
import type { ResponsiveTestResult } from '@origami/contracts';
import type { ResponsiveTestMessageResponse } from '../shared/messages.js';
import { getActiveResponsiveTest, setActiveResponsiveTest, type PersistedResponsiveTest } from '../shared/responsive-test-storage.js';

/**
 * "Test Responsive" (extension). Reuses the SAME /responsive-test route the
 * web dashboard's ResponsiveTestPanel already calls — real Playwright
 * viewport renders + the existing OrigamiRuleEngine/IssueNormalizer, never a
 * second scoring system. Auth is the same cookie-based session every other
 * extension->API call already relies on (see manifest.json's host_permissions
 * covering API_BASE — no separate token handling needed here), so a 401
 * surfaces the same errorCode: 'UNAUTHENTICATED' the popup's setError()
 * already knows how to route to the sign-in view.
 *
 * Bugfix: this used to be a bare request/response with NO persisted state —
 * a single blocking call that can legitimately take ~10-30s+ (six real
 * viewport renders). Chrome closes an action popup on blur, trivially easy
 * for a real user to trigger while waiting, which silently destroyed the
 * whole in-flight test with nothing left behind (reopening showed the plain
 * home view). This function now persists RUNNING/COMPLETED/FAILED/CANCELLED
 * to chrome.storage.local — exactly the pattern startCurrentPageScan already
 * uses in scan-coordinator.ts — so the result survives regardless of whether
 * the popup that started it is still open when it finishes.
 */

function nowIso(): string {
  return new Date().toISOString();
}

/** At most one responsive test runs at a time; its AbortController lives here so a CANCEL_RESPONSIVE_TEST message (see service-worker.ts) can actually stop the in-flight request — the API's own /responsive-test route watches for the client connection closing and aborts its own upstream browser-worker call in turn (see index.ts's onClose handler), so cancelling here really does propagate, not just give up locally. */
let activeAbortController: AbortController | null = null;

/** Same staleness guard scan-coordinator.ts uses for CURRENT_PAGE scans — an MV3 service worker CAN be killed without a chance to write a terminal status (browser crash/restart), which would otherwise leave chrome.storage.local stuck at RUNNING forever and permanently block every future test via the "already in progress" guard below. */
const STALE_RESPONSIVE_TEST_AGE_MS = 3 * 60 * 1000;

function isResponsiveTestStale(test: PersistedResponsiveTest): boolean {
  return Date.now() - new Date(test.updatedAt).getTime() > STALE_RESPONSIVE_TEST_AGE_MS;
}

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  // Structured, one-line-per-transition — never page content/cookies/tokens.
  console.log(JSON.stringify({ event, ...fields }));
}

export async function runResponsiveTest(url: string): Promise<ResponsiveTestMessageResponse> {
  const existing = await getActiveResponsiveTest();
  if (existing && existing.status === 'RUNNING' && !isResponsiveTestStale(existing)) {
    return { ok: false, error: 'A responsive test is already in progress.' };
  }

  const startedAt = nowIso();
  await setActiveResponsiveTest({ url, status: 'RUNNING', startedAt, updatedAt: startedAt });
  logEvent('RESPONSIVE_TEST_STARTED', { url });

  activeAbortController = new AbortController();
  const timeoutId = setTimeout(() => activeAbortController?.abort(), 130_000);

  try {
    const response = await fetch(`${API_BASE}/responsive-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: activeAbortController.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const { error: message = `Responsive test failed (${response.status}).`, errorCode } = err as { error?: string; errorCode?: string };
      await setActiveResponsiveTest({ url, status: 'FAILED', startedAt, updatedAt: nowIso(), error: message, errorCode });
      logEvent('RESPONSIVE_TEST_FAILED', { url, errorCode });
      return { ok: false, error: message, errorCode };
    }

    const result = (await response.json()) as ResponsiveTestResult;
    await setActiveResponsiveTest({ url, status: 'COMPLETED', startedAt, updatedAt: nowIso(), result });
    logEvent('RESPONSIVE_TEST_COMPLETED', { url, viewportCount: result.viewports.length });
    return { ok: true, result };
  } catch (error) {
    // A CANCEL_RESPONSIVE_TEST abort() already wrote status: 'CANCELLED' — don't overwrite it with a generic AbortError message.
    const current = await getActiveResponsiveTest();
    if (current?.status === 'CANCELLED') {
      return { ok: false, error: 'Responsive test cancelled.', errorCode: 'CANCELLED' };
    }
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? 'Responsive test timed out.'
        : error instanceof Error
          ? error.message
          : 'Failed to reach the Origami API.';
    await setActiveResponsiveTest({ url, status: 'FAILED', startedAt, updatedAt: nowIso(), error: message });
    logEvent('RESPONSIVE_TEST_FAILED', { url, error: message });
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeoutId);
    activeAbortController = null;
  }
}

export async function getResponsiveTestState(): Promise<PersistedResponsiveTest | null> {
  return getActiveResponsiveTest();
}

export async function clearActiveResponsiveTest(): Promise<void> {
  await setActiveResponsiveTest(null);
}

/** Cancel Test — aborts the in-flight fetch (which the API route turns into a real upstream abort, see this file's doc comment) and immediately marks the persisted state CANCELLED so the popup reflects it right away rather than waiting for the abort to unwind. */
export async function cancelResponsiveTest(): Promise<{ ok: boolean }> {
  const existing = await getActiveResponsiveTest();
  if (existing && existing.status === 'RUNNING') {
    await setActiveResponsiveTest({ ...existing, status: 'CANCELLED', updatedAt: nowIso() });
    logEvent('RESPONSIVE_TEST_CANCELLED', { url: existing.url });
  }
  activeAbortController?.abort();
  return { ok: true };
}
