/// <reference types="chrome" />

/**
 * Create Bug Report — the isolated-world counterpart to page-monitor-main.ts
 * (the MAIN-world script that actually observes console.error/fetch/XHR).
 * Registered as its OWN content_scripts entry at document_start — same
 * timing as the MAIN-world script — specifically so its listeners are
 * attached before any page script runs, otherwise an error thrown in the
 * first tick of the page's own scripts could fire before anything is
 * listening and be silently lost (CustomEvents are not queued/buffered).
 *
 * Kept separate from content-script.ts (which still loads at document_idle
 * for its own, unrelated DOM-querying work) rather than moving that whole
 * file earlier, to avoid any risk to its existing timing assumptions.
 */

interface BugReportConsoleEntry {
  type: 'error' | 'exception';
  message: string;
  timestamp: number;
  stack?: string;
}

interface BugReportNetworkEntry {
  url: string;
  method: string;
  status: number;
  duration: number;
  resourceType: string;
  failed: boolean;
}

const MAX_BUFFER = 20;
const consoleBuffer: BugReportConsoleEntry[] = [];
const networkBuffer: BugReportNetworkEntry[] = [];

function pushBounded<T>(buffer: T[], entry: T): void {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
}

window.addEventListener('__origami_console_error__', ((event: CustomEvent<BugReportConsoleEntry>) => {
  pushBounded(consoleBuffer, event.detail);
}) as EventListener);

window.addEventListener('__origami_network_error__', ((event: CustomEvent<BugReportNetworkEntry>) => {
  pushBounded(networkBuffer, event.detail);
}) as EventListener);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GET_BUG_REPORT_CONTEXT') {
    sendResponse({
      consoleErrors: [...consoleBuffer],
      networkErrors: [...networkBuffer],
    });
    return true;
  }
  return false;
});
