/**
 * Regression coverage for the "Test Responsive doesn't actually work" bug:
 * the feature used to be a bare in-popup request/response with NO persisted
 * state, so if the popup closed while the ~10-130s test was still running
 * (trivially easy for a real user — Chrome closes an action popup on blur),
 * the whole thing silently vanished. These tests stub chrome.storage.local
 * (an in-memory map, matching the promise-based get/set/remove shape MV3
 * actually provides) and global fetch, and assert directly on what gets
 * PERSISTED at each stage — the same thing a real popup reopening after a
 * close would read back. This is deliberately a hermetic unit test (no real
 * Chromium/backend) for the coordinator's own state-machine logic; the full
 * real-browser, real-backend version of this same scenario (register a real
 * user, start a test, close the popup, reopen it, verify the real result
 * survived) was verified manually against the running dev stack — see the
 * FINAL OUTPUT report's "Manual test result".
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

interface StorageChange { newValue?: unknown; oldValue?: unknown }
const store = new Map<string, unknown>();
const changeListeners: Array<(changes: Record<string, StorageChange>, area: string) => void> = [];

function notifyChange(key: string, newValue: unknown, oldValue: unknown) {
  for (const listener of changeListeners) listener({ [key]: { newValue, oldValue } }, 'local');
}

(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: store.get(key) }),
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) {
          const old = store.get(k);
          store.set(k, v);
          notifyChange(k, v, old);
        }
      },
      remove: async (key: string) => {
        const old = store.get(key);
        store.delete(key);
        notifyChange(key, undefined, old);
      },
    },
    onChanged: {
      addListener: (fn: (changes: Record<string, StorageChange>, area: string) => void) => { changeListeners.push(fn); },
    },
  },
};

const { runResponsiveTest, cancelResponsiveTest, clearActiveResponsiveTest, getResponsiveTestState } = await import('./responsive-test-coordinator.js');
const { RESPONSIVE_TEST_STORAGE_KEY } = await import('../shared/responsive-test-storage.js');

const originalFetch = globalThis.fetch;

beforeEach(() => {
  store.clear();
  changeListeners.length = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fakeResult(url: string) {
  return { url, viewports: [{ width: 375, label: '375px', issues: [], issueCount: 0, screenshotBase64: 'ZmFrZQ==' }] };
}

describe('responsive-test-coordinator — persisted state (bugfix: survives the popup closing mid-test)', () => {
  it('persists RUNNING to chrome.storage.local BEFORE the fetch resolves — this is what a reopened popup reads if it closed mid-test', async () => {
    let sawRunningDuringFetch = false;
    globalThis.fetch = (async () => {
      const state = await getResponsiveTestState();
      sawRunningDuringFetch = state?.status === 'RUNNING';
      return new Response(JSON.stringify(fakeResult('https://example.com')), { status: 200 });
    }) as typeof fetch;

    await runResponsiveTest('https://example.com');
    assert.equal(sawRunningDuringFetch, true, 'RUNNING must be persisted before awaiting the network call, not after');
  });

  it('persists the real COMPLETED result — a reopened popup can render it directly without re-running anything', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(fakeResult('https://example.com')), { status: 200 })) as typeof fetch;
    const response = await runResponsiveTest('https://example.com');
    assert.equal(response.ok, true);

    const state = await getResponsiveTestState();
    assert.equal(state?.status, 'COMPLETED');
    assert.deepEqual(state?.result, fakeResult('https://example.com'));
  });

  it('persists FAILED with the real error/errorCode on a non-2xx API response, never silently dropping it', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' }), { status: 401 })) as typeof fetch;

    const response = await runResponsiveTest('https://example.com');
    assert.equal(response.ok, false);
    assert.equal(response.errorCode, 'UNAUTHENTICATED');

    const state = await getResponsiveTestState();
    assert.equal(state?.status, 'FAILED');
    assert.equal(state?.errorCode, 'UNAUTHENTICATED');
  });

  it('rejects starting a second test while one is genuinely RUNNING (never two concurrent jobs)', async () => {
    let resolveFetch: (r: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveFetch = resolve; })) as typeof fetch;

    const first = runResponsiveTest('https://example.com');
    // Let the first call persist RUNNING before the second one checks it.
    await new Promise((r) => setTimeout(r, 10));

    const second = await runResponsiveTest('https://example.com');
    assert.equal(second.ok, false);
    assert.match(second.error!, /already in progress/i);

    resolveFetch!(new Response(JSON.stringify(fakeResult('https://example.com')), { status: 200 }));
    await first;
  });

  it('cancelResponsiveTest actually aborts the in-flight fetch AND persists CANCELLED — a cancelled test never later overwrites itself with a stale COMPLETED result', async () => {
    let sawAbort = false;
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          sawAbort = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as typeof fetch;

    const runPromise = runResponsiveTest('https://example.com');
    await new Promise((r) => setTimeout(r, 10));

    const cancelResult = await cancelResponsiveTest();
    assert.equal(cancelResult.ok, true);

    const response = await runPromise;
    assert.equal(response.ok, false);
    assert.equal(response.errorCode, 'CANCELLED');
    assert.equal(sawAbort, true, 'the real fetch must actually be aborted, not just marked cancelled locally');

    const state = await getResponsiveTestState();
    assert.equal(state?.status, 'CANCELLED');
  });

  it('clearActiveResponsiveTest actually removes the persisted record — bugfix regression: a FAILED test used to stay in storage forever, so popup.ts\'s dismissError() re-showed the SAME error on every future popup open (the same "sticky error" bug this codebase already fixed once for scans)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'down' }), { status: 500 })) as typeof fetch;
    await runResponsiveTest('https://example.com');
    assert.equal((await getResponsiveTestState())?.status, 'FAILED');

    await clearActiveResponsiveTest();
    assert.equal(await getResponsiveTestState(), null);
  });

  it('notifies chrome.storage.onChanged listeners on every transition — this is what lets an OPEN popup update live, and a CLOSED popup catch up on reopen', async () => {
    const seenStatuses: string[] = [];
    changeListeners.push((changes) => {
      const change = changes[RESPONSIVE_TEST_STORAGE_KEY];
      if (change?.newValue) seenStatuses.push((change.newValue as { status: string }).status);
    });

    globalThis.fetch = (async () => new Response(JSON.stringify(fakeResult('https://example.com')), { status: 200 })) as typeof fetch;
    await runResponsiveTest('https://example.com');

    assert.deepEqual(seenStatuses, ['RUNNING', 'COMPLETED']);
  });
});
