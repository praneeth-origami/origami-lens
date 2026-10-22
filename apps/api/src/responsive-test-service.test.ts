import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsiveTestError, runResponsiveTest } from './responsive-test-service.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function emptyDom() {
  return { headings: [], images: [], links: [], buttons: [], forms: [], iframes: [] };
}

function viewportsResponse(viewports: unknown[]): Response {
  return new Response(JSON.stringify({ viewports }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('runResponsiveTest', () => {
  it('rejects an invalid URL before ever calling the browser worker', async () => {
    let called = false;
    globalThis.fetch = (() => { called = true; return Promise.resolve(viewportsResponse([])); }) as typeof fetch;
    await assert.rejects(
      () => runResponsiveTest('not a url', undefined),
      (error: unknown) => { assert.ok(error instanceof ResponsiveTestError); assert.equal(error.code, 'URL_INVALID'); return true; },
    );
    assert.equal(called, false);
  });

  it('evaluates the real rule engine per viewport and returns only visualMobile-category issues, labeling the last width as Desktop', async () => {
    globalThis.fetch = (() => Promise.resolve(viewportsResponse([
      {
        width: 375,
        viewport: { width: 375, height: 900 },
        dom: emptyDom(),
        layout: { horizontalOverflow: true, overflowWidth: 40, elementsOutsideViewport: [], fixedWidthElements: [] },
        screenshotBase64: 'ZmFrZS0zNzU=',
      },
      {
        width: 1280,
        viewport: { width: 1280, height: 900 },
        dom: emptyDom(),
        layout: { horizontalOverflow: false, elementsOutsideViewport: [], fixedWidthElements: [] },
        screenshotBase64: 'ZmFrZS0xMjgw',
      },
    ]))) as typeof fetch;

    const result = await runResponsiveTest('https://example.com', [375, 1280]);

    assert.equal(result.url, 'https://example.com');
    assert.equal(result.viewports.length, 2);
    assert.equal(result.viewports[0]!.width, 375);
    assert.equal(result.viewports[0]!.label, '375px');
    assert.ok(result.viewports[0]!.issueCount >= 1);
    assert.ok(result.viewports[0]!.issues.every((i) => i.category === 'visualMobile'));
    assert.match(result.viewports[0]!.issues[0]!.title, /overflow/i);
    assert.equal(result.viewports[0]!.screenshotBase64, 'ZmFrZS0zNzU=');

    assert.equal(result.viewports[1]!.width, 1280);
    assert.equal(result.viewports[1]!.label, '1280px (Desktop)');
    assert.equal(result.viewports[1]!.issueCount, 0);
    assert.equal(result.viewports[1]!.screenshotBase64, 'ZmFrZS0xMjgw');
  });

  it('defaults screenshotBase64 to an empty string (never undefined) if the browser worker response omits it', async () => {
    globalThis.fetch = (() => Promise.resolve(viewportsResponse([
      { width: 375, viewport: { width: 375, height: 900 }, dom: emptyDom(), layout: { horizontalOverflow: false, elementsOutsideViewport: [], fixedWidthElements: [] } },
    ]))) as typeof fetch;
    const result = await runResponsiveTest('https://example.com', [375]);
    assert.equal(result.viewports[0]!.screenshotBase64, '');
  });

  it('detects overlapping nav/header elements via VIS_OVERLAPPING_ELEMENTS', async () => {
    globalThis.fetch = (() => Promise.resolve(viewportsResponse([
      {
        width: 390,
        viewport: { width: 390, height: 900 },
        dom: emptyDom(),
        layout: {
          horizontalOverflow: false, elementsOutsideViewport: [], fixedWidthElements: [],
          overlappingElements: [{ selector: 'nav.main + div.logo', tag: 'nav', attributes: {}, boundingBox: { x: 0, y: 0, width: 100, height: 40 } }],
        },
      },
    ]))) as typeof fetch;

    const result = await runResponsiveTest('https://example.com', [390]);
    assert.ok(result.viewports[0]!.issues.some((i) => i.ruleId === 'VIS_OVERLAPPING_ELEMENTS'));
  });

  it('maps a non-2xx browser-worker response to RESPONSIVE_TEST_FAILED (reached the worker, but it errored)', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ error: 'down' }), { status: 500 }))) as typeof fetch;
    await assert.rejects(
      () => runResponsiveTest('https://example.com', undefined),
      (error: unknown) => { assert.ok(error instanceof ResponsiveTestError); assert.equal(error.code, 'RESPONSIVE_TEST_FAILED'); return true; },
    );
  });

  it('maps a network-level failure to BROWSER_WORKER_UNAVAILABLE (never reached the worker at all)', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await assert.rejects(
      () => runResponsiveTest('https://example.com', undefined),
      (error: unknown) => { assert.ok(error instanceof ResponsiveTestError); assert.equal(error.code, 'BROWSER_WORKER_UNAVAILABLE'); return true; },
    );
  });

  it('bounds the requested widths to at most 8, never forwarding an unbounded list to the browser worker', async () => {
    let capturedWidths: number[] | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedWidths = JSON.parse(init!.body as string).widths;
      return Promise.resolve(viewportsResponse(capturedWidths!.map((w) => ({ width: w, viewport: { width: w, height: 900 }, dom: emptyDom(), layout: { horizontalOverflow: false, elementsOutsideViewport: [], fixedWidthElements: [] } }))));
    }) as typeof fetch;

    await runResponsiveTest('https://example.com', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(capturedWidths!.length, 8);
  });
});
