/// <reference types="chrome" />

/** Shared by service-worker.ts's message router and any coordinator that needs to guarantee content-script.ts is alive in a tab before messaging it (e.g. a tab open before the extension was installed/reloaded never got it injected automatically). */
export function pingTab(tabId: number): Promise<boolean> {
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

export async function ensureContentScript(tabId: number): Promise<void> {
  const alive = await pingTab(tabId);
  if (alive) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content-script.js'],
  });

  await new Promise((r) => setTimeout(r, 100));
}
