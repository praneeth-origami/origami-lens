/// <reference types="chrome" />

import type { ExtensionMessage } from '../shared/messages.js';
import {
  clearActiveScan,
  getScanState,
  recoverScanOnStartup,
  registerScanAlarmListener,
  startCurrentPageScan,
  startWebsiteScan,
} from './scan-coordinator.js';
import {
  clearActiveComponentJob,
  getComponentJobState,
  recoverComponentJobOnStartup,
  registerComponentAlarmListener,
  startComponentGeneration,
} from './component-coordinator.js';

function pingTab(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(false);
      } else {
        resolve(Boolean(response?.pong));
      }
    });
  });
}

async function ensureContentScript(tabId: number): Promise<void> {
  const alive = await pingTab(tabId);
  if (alive) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content-script.js'],
  });

  await new Promise((r) => setTimeout(r, 100));
}

function collectFromTab(tabId: number): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'COLLECT_EVIDENCE' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

registerScanAlarmListener();
recoverScanOnStartup().catch(() => {});
registerComponentAlarmListener();
recoverComponentJobOnStartup().catch(() => {});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ tab: tabs[0] ?? null });
    });
    return true;
  }

  if (message.type === 'COLLECT_FROM_TAB') {
    const tabId = message.tabId;

    (async () => {
      try {
        await ensureContentScript(tabId);
        let response = await collectFromTab(tabId);

        if (!(response as { success?: boolean })?.success) {
          await ensureContentScript(tabId);
          response = await collectFromTab(tabId);
        }

        sendResponse(response);
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Could not access page. Try a normal http(s) tab.',
        });
      }
    })();

    return true;
  }

  if (message.type === 'START_WEBSITE_SCAN') {
    startWebsiteScan(message.options)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to start website scan.',
        });
      });
    return true;
  }

  if (message.type === 'START_CURRENT_PAGE_SCAN') {
    startCurrentPageScan(message.targetUrl, message.pageEvidence)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to start page scan.',
        });
      });
    return true;
  }

  if (message.type === 'GET_SCAN_STATE') {
    getScanState()
      .then((activeScan) => sendResponse({ activeScan }))
      .catch(() => sendResponse({ activeScan: null }));
    return true;
  }

  if (message.type === 'CLEAR_ACTIVE_SCAN') {
    clearActiveScan()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'START_ELEMENT_SELECTION') {
    const tabId = message.tabId;
    (async () => {
      try {
        await ensureContentScript(tabId);
        chrome.tabs.sendMessage(tabId, { type: 'START_ELEMENT_SELECTION' }, (response) => {
          sendResponse(response ?? { success: false, error: 'No response from page.' });
        });
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Could not enter selection mode on this page.',
        });
      }
    })();
    return true;
  }

  if (message.type === 'CANCEL_ELEMENT_SELECTION') {
    chrome.tabs.sendMessage(message.tabId, { type: 'CANCEL_ELEMENT_SELECTION' }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'CAPTURE_VISIBLE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const windowId = tabs[0]?.windowId;
      if (windowId === undefined) {
        sendResponse({ error: 'No active tab to capture.' });
        return;
      }
      chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 92 }, (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          sendResponse({ error: chrome.runtime.lastError?.message ?? 'Screenshot capture failed.' });
        } else {
          sendResponse({ dataUrl });
        }
      });
    });
    return true;
  }

  if (message.type === 'START_COMPONENT_GENERATION') {
    startComponentGeneration(message.target, message.evidence)
      .then((result) => sendResponse({ ok: result.ok, jobId: result.jobId, error: result.error }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to start code generation.',
        });
      });
    return true;
  }

  if (message.type === 'GET_COMPONENT_JOB_STATE') {
    getComponentJobState()
      .then((activeJob) => sendResponse({ activeJob }))
      .catch(() => sendResponse({ activeJob: null }));
    return true;
  }

  if (message.type === 'CLEAR_COMPONENT_JOB') {
    clearActiveComponentJob()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});
