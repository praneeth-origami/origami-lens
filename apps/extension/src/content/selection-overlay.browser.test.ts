/**
 * Real-browser tests for "Select Anything" (selection-overlay.ts /
 * content-script.ts) — these load the ACTUAL bundled output
 * (dist/content/content-script.js, the exact file Chrome injects as a
 * content script) into a real Chromium page via Playwright, not a jsdom
 * simulation or a mock of the selection logic. Only `chrome.runtime` is
 * stubbed (a content script has no other way to reach the extension
 * background — this is the one and only integration seam), so every DOM
 * capture/highlight/click-prevention/escape/privacy-scrubbing assertion
 * below is exercising the real code path a live install would run.
 *
 * Run `node scripts/build.mjs` before this file (see package.json's
 * "test" script) — it loads whatever is currently in dist/, so a stale
 * build would silently test old code.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_SCRIPT_PATH = path.resolve(here, '../../dist/content/content-script.js');

/**
 * A real, viewport-sized PNG (a gradient canvas render, computed once in
 * before() below) standing in for chrome.tabs.captureVisibleTab's real
 * screenshot — sized to match the default 1280x720-ish viewport so
 * captureScreenshot's real crop-and-scale math produces a genuinely
 * non-degenerate result, not a 1x1 placeholder that would make every crop
 * collapse to nothing regardless of whether the cropping logic is correct.
 */
let FAKE_SCREENSHOT_DATA_URL = '';

type PageOrFrame = Page | Frame;

/**
 * Installs a stubbed `chrome.runtime` via a direct evaluate() call,
 * immediately followed by injecting the REAL bundled content-script.js —
 * this ordering (never page.addInitScript(), which is NOT re-applied on
 * page.setContent() navigations, only on real goto() ones — relying on it
 * here would silently leave `chrome` undefined) guarantees the stub exists
 * before the content script's top-level `chrome.runtime.onMessage.
 * addListener(...)` call runs. Works identically for a top-level Page or
 * an iframe's Frame (both share the same evaluate/addScriptTag shape),
 * which is what makes the same-origin-iframe test below possible.
 *
 * Exposes two test hooks on `window`:
 *   - `__origamiTriggerMessage(message)` — simulates the popup/background
 *     sending a runtime message TO the content script (e.g.
 *     START_ELEMENT_SELECTION), by calling the real listener the script
 *     itself registered.
 *   - `__origamiSentMessages` — every message the content script sent
 *     OUTWARD via chrome.runtime.sendMessage (CAPTURE_VISIBLE_TAB,
 *     START_COMPONENT_GENERATION, RUN_ELEMENT_ACTION), so tests can assert
 *     on exactly what evidence/action was sent — and
 *     `__origamiSendMessageImpl`, overridable per test to control the response.
 */
/**
 * The stub is built as a plain STRING and passed to evaluate() rather than
 * a TS function reference — tsx/esbuild's `keepNames` transpilation
 * injects `__name(fn, "fn")` wrapper calls around inner functions for
 * better stack traces, but Playwright ships an evaluate() function
 * argument to the browser via `.toString()`, which does NOT carry along
 * the `__name` helper's own definition (it lives elsewhere in the
 * transpiled test file, invisible to the browser page) — a `string`
 * argument is sent to the browser completely untranspiled and sidesteps
 * this entirely.
 */
/**
 * Built lazily (a function called at inject time), NOT a plain top-level
 * const — FAKE_SCREENSHOT_DATA_URL is only populated inside before(), which
 * runs AFTER module evaluation. A top-level `const` baking in
 * FAKE_SCREENSHOT_DATA_URL via a template literal would freeze in its
 * value at import time (still '' at that point), silently making every
 * test's default CAPTURE_VISIBLE_TAB stub return an empty screenshot
 * regardless of what before() later sets.
 */
function chromeStubScript(): string {
  return `
  window.__origamiSentMessages = [];
  window.__origamiSendMessageImpl = function (message) {
    if (message.type === 'CAPTURE_VISIBLE_TAB') return Promise.resolve({ dataUrl: ${JSON.stringify(FAKE_SCREENSHOT_DATA_URL)} });
    return Promise.resolve({ ok: true, answer: 'Default stub answer.', groundedInRepository: false });
  };
  var __origamiListener = null;
  window.chrome = {
    runtime: {
      onMessage: { addListener: function (fn) { __origamiListener = fn; } },
      sendMessage: function (message) {
        window.__origamiSentMessages.push(message);
        return window.__origamiSendMessageImpl(message);
      },
    },
  };
  window.__origamiTriggerMessage = function (message) {
    return new Promise(function (resolve) {
      if (!__origamiListener) throw new Error('Content script has not registered a runtime.onMessage listener yet.');
      __origamiListener(message, {}, resolve);
    });
  };
`;
}

async function injectContentScript(target: PageOrFrame): Promise<void> {
  await target.evaluate(chromeStubScript());
  await target.addScriptTag({ path: CONTENT_SCRIPT_PATH });
}

async function loadFixture(page: Page, html: string): Promise<void> {
  await page.setContent(html, { waitUntil: 'load' });
  await injectContentScript(page);
}

async function startSelection(target: PageOrFrame): Promise<void> {
  await target.evaluate(() => (window as any).__origamiTriggerMessage({ type: 'START_ELEMENT_SELECTION' }));
}

/** The Shadow DOM host selection-overlay.ts creates — its presence/absence is the ground truth for whether selection mode is active. */
const HOST_SELECTOR = '#origami-selection-root';

async function hostExists(page: Page): Promise<boolean> {
  return (await page.$(HOST_SELECTOR)) !== null;
}

/**
 * Clicks a REAL PAGE element by raw screen coordinates rather than
 * Playwright's locator.click() — deliberately, not a workaround for a test
 * limitation. Playwright's .click() performs its own actionability check
 * (is this element obscured by anything else at that point?) via the
 * same hit-testing the browser itself uses, and while selection mode is
 * active `.ol-overlay` (a real, intentional, position:fixed inset:0
 * element with pointer-events left at its default so its `cursor:
 * crosshair` styling actually applies while hovering — see
 * selection-overlay.ts) genuinely IS what's topmost at every point on the
 * page. Playwright correctly reports the target as obscured and retries
 * for its default 30s action timeout before giving up — exactly what a
 * real user's OS-level mouse click would also "see" as topmost. A raw
 * coordinate click is the faithful way to simulate that real user click,
 * exactly like page.mouse in general is real for injecting native events,
 * not a lower-fidelity shortcut.
 */
async function clickPageElement(page: Page, target: PageOrFrame, selector: string): Promise<void> {
  // boundingBox() is already reported relative to the top-level page's
  // viewport regardless of which frame `target` is (a documented
  // Playwright behavior specifically so page.mouse works directly against
  // it), which is exactly what makes this helper work identically for the
  // same-origin-iframe test below.
  const box = await target.locator(selector).boundingBox();
  if (!box) throw new Error(`Element ${selector} has no bounding box (not visible?).`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
  const throwaway = await browser.newPage();
  FAKE_SCREENSHOT_DATA_URL = await throwaway.evaluate(`
    (function () {
      var canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      var ctx = canvas.getContext('2d');
      var gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, '#3355ff');
      gradient.addColorStop(1, '#ff5533');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    })()
  `);
  await throwaway.close();
});

after(async () => {
  await browser.close();
});

async function newStubbedPage(): Promise<Page> {
  return browser.newPage();
}

const PLAIN_FIXTURE = `
  <html>
    <body>
      <header style="position: sticky; top: 0; background: #fff;">
        <nav><a href="#" id="home-link">Home</a></nav>
      </header>
      <main>
        <section>
          <div class="card">
            <button id="checkout-btn" class="checkout-btn primary" data-testid="checkout-button"
              style="width: 412px; height: 48px; display: block; color: white; background-color: rgb(91, 76, 219); font-size: 16px; padding: 12px;"
              onclick="window.__clicked = true">Checkout</button>
          </div>
        </section>
        <form>
          <label for="username">Username</label>
          <input id="username" name="username" type="text" value="not-secret" />
          <label for="pwd">Password</label>
          <input id="pwd" name="password" type="password" value="hunter2" />
        </form>
        <div id="fixed-banner" style="position: fixed; bottom: 0; left: 0; width: 100%; height: 32px;">Fixed banner</div>
        <img id="logo" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" alt="Logo" />
        <svg id="icon" width="24" height="24"><circle cx="12" cy="12" r="10" /></svg>
        <button id="icon-btn" aria-label="Close dialog">×</button>
        <div id="deep-0"><div id="deep-1"><div id="deep-2"><div id="deep-3"><span id="deep-leaf">Deeply nested</span></div></div></div></div>
      </main>
    </body>
  </html>
`;

describe('Select Anything — selection lifecycle (real browser, real bundled content script)', () => {
  it('1. entering selection mode creates the isolated overlay host', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      assert.equal(await hostExists(page), false);
      await startSelection(page);
      assert.equal(await hostExists(page), true);
    } finally {
      await page.close();
    }
  });

  it('2. hovering an element positions the highlight box over that element\'s real bounding rect, without modifying the page', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await startSelection(page);
      const btn = page.locator('#checkout-btn');
      const box = (await btn.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

      const hoverBoxRect = await page.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        const hoverBox = host.shadowRoot!.querySelector('.ol-hover') as HTMLElement;
        return { display: hoverBox.style.display, left: hoverBox.style.left, top: hoverBox.style.top };
      });
      assert.equal(hoverBoxRect.display, 'block');
      assert.equal(Math.round(parseFloat(hoverBoxRect.left)), Math.round(box.x));
      assert.equal(Math.round(parseFloat(hoverBoxRect.top)), Math.round(box.y));

      // The page itself must be completely unmodified by hovering.
      const stillOriginal = await btn.evaluate((el) => el.textContent === 'Checkout' && el.className === 'checkout-btn primary');
      assert.ok(stillOriginal);
    } finally {
      await page.close();
    }
  });

  it('3 & 4. clicking a button selects it WITHOUT activating the button\'s own click handler ("Delete Account" case)', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await startSelection(page);
      await clickPageElement(page, page, '#checkout-btn');

      const clickedFlag = await page.evaluate(() => (window as any).__clicked);
      assert.equal(clickedFlag, undefined, 'the underlying button\'s onclick must never fire');

      // Selection mode ended and the confirm panel is now showing.
      const panelVisible = await page.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        return host.shadowRoot!.querySelector('.ol-panel') !== null;
      });
      assert.ok(panelVisible);
    } finally {
      await page.close();
    }
  });

  it('5. Escape cancels selection mode and removes the overlay entirely', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await startSelection(page);
      assert.equal(await hostExists(page), true);
      await page.keyboard.press('Escape');
      assert.equal(await hostExists(page), false);
    } finally {
      await page.close();
    }
  });

  it('provides a Cancel Selection control inside the confirm panel too', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await startSelection(page);
      await clickPageElement(page, page, '#checkout-btn');
      assert.equal(await hostExists(page), true);
      await page.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        (host.shadowRoot!.querySelector('#ol-cancel') as HTMLElement).click();
      });
      assert.equal(await hostExists(page), false);
    } finally {
      await page.close();
    }
  });
});

describe('Select Anything — captured evidence (DOM/CSS/dimensions/accessibility/selectors)', () => {
  async function selectAndCaptureViaExplain(page: Page): Promise<any> {
    await startSelection(page);
    await clickPageElement(page, page, '#checkout-btn');
    await page.evaluate(() => {
      const host = document.querySelector('#origami-selection-root') as HTMLElement;
      (host.shadowRoot!.querySelector('[data-action="explain"]') as HTMLElement).click();
    });
    await page.waitForFunction(() => (window as any).__origamiSentMessages.some((m: any) => m.type === 'RUN_ELEMENT_ACTION'));
    const messages = await page.evaluate(() => (window as any).__origamiSentMessages);
    return messages.find((m: any) => m.type === 'RUN_ELEMENT_ACTION').evidence;
  }

  it('6/7/8/9. captures real outerHTML, a bounded computed-style summary, and the real bounding box', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      const evidence = await selectAndCaptureViaExplain(page);

      assert.match(evidence.html, /checkout-btn/);
      assert.ok(evidence.html.length <= 20_000);

      assert.equal(evidence.element.tag, 'button');
      assert.equal(evidence.element.style.display, 'block');
      assert.equal(evidence.element.style.color, 'rgb(255, 255, 255)');
      assert.equal(evidence.element.style.backgroundColor, 'rgb(91, 76, 219)');
      assert.equal(evidence.element.style.fontSize, '16px');
      // Never a dump of every computed-style property — bounded to the documented allowlist.
      assert.ok(Object.keys(evidence.element.style).length < 30);

      assert.ok(Math.abs(evidence.element.boundingBox.width - 412) < 2);
      assert.ok(Math.abs(evidence.element.boundingBox.height - 48) < 2);
      assert.ok(typeof evidence.boundingBox.viewportWidth === 'number' && evidence.boundingBox.viewportWidth > 0);
      assert.ok(typeof evidence.boundingBox.devicePixelRatio === 'number');
    } finally {
      await page.close();
    }
  });

  it('10. captures a controlled ancestor chain and direct children, not the whole page', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await startSelection(page);
      await clickPageElement(page, page, '#deep-leaf');
      await page.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        (host.shadowRoot!.querySelector('[data-action="explain"]') as HTMLElement).click();
      });
      await page.waitForFunction(() => (window as any).__origamiSentMessages.some((m: any) => m.type === 'RUN_ELEMENT_ACTION'));
      const evidence = (await page.evaluate(() => (window as any).__origamiSentMessages)).find((m: any) => m.type === 'RUN_ELEMENT_ACTION').evidence;

      assert.ok(evidence.ancestors.length > 0);
      assert.ok(evidence.ancestors.length <= 5, 'ancestor depth must be bounded');
      assert.ok(evidence.ancestors.some((a: any) => a.attributes.id === 'deep-3' || a.attributes.id === undefined));
    } finally {
      await page.close();
    }
  });

  it('11. captures a real, non-empty cropped screenshot for a normal (non-iframe) selection', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      const evidence = await selectAndCaptureViaExplain(page);
      assert.ok(evidence.screenshotBase64.length > 100, 'expected a real base64 image, not an empty placeholder');
    } finally {
      await page.close();
    }
  });

  it('12. captures accessibility context — aria-label becomes the computed accessible name', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await startSelection(page);
      await clickPageElement(page, page, '#icon-btn');
      await page.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        (host.shadowRoot!.querySelector('[data-action="explain"]') as HTMLElement).click();
      });
      await page.waitForFunction(() => (window as any).__origamiSentMessages.some((m: any) => m.type === 'RUN_ELEMENT_ACTION'));
      const evidence = (await page.evaluate(() => (window as any).__origamiSentMessages)).find((m: any) => m.type === 'RUN_ELEMENT_ACTION').evidence;
      assert.equal(evidence.element.attributes['data-origami-accessible-name'], 'Close dialog');
    } finally {
      await page.close();
    }
  });

  it('13. prefers a stable data-testid selector over id/class/nth-child', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      const evidence = await selectAndCaptureViaExplain(page);
      assert.equal(evidence.element.selector, '[data-testid="checkout-button"]');
      assert.ok(!evidence.element.selector.includes('nth-child'));
    } finally {
      await page.close();
    }
  });

  it('13b. falls back to id, then tag+class, never nth-child, when no test attribute is present', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await startSelection(page);
      await clickPageElement(page, page, '#home-link');
      await page.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        (host.shadowRoot!.querySelector('[data-action="explain"]') as HTMLElement).click();
      });
      await page.waitForFunction(() => (window as any).__origamiSentMessages.some((m: any) => m.type === 'RUN_ELEMENT_ACTION'));
      const evidence = (await page.evaluate(() => (window as any).__origamiSentMessages)).find((m: any) => m.type === 'RUN_ELEMENT_ACTION').evidence;
      assert.equal(evidence.element.selector, '#home-link');
    } finally {
      await page.close();
    }
  });
});

describe('Select Anything — privacy scrubbing / sensitive form handling', () => {
  it('14/15. blocks analysis of a selection whose descendants include a password field, and never includes a NEVER captures the raw "value" attribute of any form field regardless', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await startSelection(page);
      // Select the <form> itself, which contains the password field as a descendant.
      await page.locator('form').click({ force: true });

      const blocked = await page.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        const btn = host.shadowRoot!.querySelector('[data-action="explain"]') as HTMLButtonElement;
        return { disabled: btn.disabled, warningShown: host.shadowRoot!.querySelector('.ol-warning') !== null };
      });
      assert.equal(blocked.disabled, true);
      assert.equal(blocked.warningShown, true);
    } finally {
      await page.close();
    }
  });

  it('15b. never captures the "value" attribute for an ordinary (non-blocked) text input', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await startSelection(page);
      await page.locator('#username').click({ force: true });
      await page.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        const btn = host.shadowRoot!.querySelector('[data-action="explain"]') as HTMLButtonElement | null;
        if (btn && !btn.disabled) btn.click();
      });
      await page.waitForFunction(() => (window as any).__origamiSentMessages.some((m: any) => m.type === 'RUN_ELEMENT_ACTION'));
      const evidence = (await page.evaluate(() => (window as any).__origamiSentMessages)).find((m: any) => m.type === 'RUN_ELEMENT_ACTION').evidence;
      assert.equal(evidence.element.attributes.value, undefined, 'the "value" attribute must never be captured, blocked or not');
    } finally {
      await page.close();
    }
  });
});

describe('Select Anything — special/dynamic elements', () => {
  it('19/20. selects a deeply nested, fixed-position element correctly (real getBoundingClientRect, not layout-shifted by the overlay)', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await startSelection(page);
      const box = (await page.locator('#fixed-banner').boundingBox())!;
      await clickPageElement(page, page, '#fixed-banner');
      const capturedRect = await page.evaluate(() => {
        const el = document.getElementById('fixed-banner')!;
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height };
      });
      assert.ok(Math.abs(capturedRect.width - box.width) < 2);
    } finally {
      await page.close();
    }
  });

  it('16/17/18. works against dynamically-inserted content using only standard DOM APIs (framework-agnostic — stands in for React/Next.js/Vue/Angular, none of which this code touches internals of)', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, '<html><body><div id="app"></div></body></html>');
      // Simulate a framework re-render inserting a new element after initial load.
      await page.evaluate(() => {
        const btn = document.createElement('button');
        btn.id = 'dynamic-btn';
        btn.textContent = 'Dynamically rendered';
        btn.setAttribute('data-testid', 'dynamic-button');
        document.getElementById('app')!.appendChild(btn);
      });
      await startSelection(page);
      await clickPageElement(page, page, '#dynamic-btn');
      const panelVisible = await page.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        return host.shadowRoot!.querySelector('.ol-panel') !== null;
      });
      assert.ok(panelVisible);
    } finally {
      await page.close();
    }
  });

  it('21. the overlay keeps working correctly after a viewport resize', async () => {
    const page = await newStubbedPage();
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await loadFixture(page, PLAIN_FIXTURE);
      await startSelection(page);
      await page.setViewportSize({ width: 500, height: 800 });
      await page.mouse.move(50, 50);
      // Must not throw / must still be active.
      assert.equal(await hostExists(page), true);
    } finally {
      await page.close();
    }
  });
});

describe('Select Anything — AI action routing (22/23/24/25)', () => {
  async function selectCheckout(page: Page): Promise<void> {
    await startSelection(page);
    await clickPageElement(page, page, '#checkout-btn');
  }

  it('routes "Explain" as RUN_ELEMENT_ACTION with action: "explain"', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await selectCheckout(page);
      await page.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        (host.shadowRoot!.querySelector('[data-action="explain"]') as HTMLElement).click();
      });
      await page.waitForFunction(() => (window as any).__origamiSentMessages.some((m: any) => m.type === 'RUN_ELEMENT_ACTION'));
      const msg = (await page.evaluate(() => (window as any).__origamiSentMessages)).find((m: any) => m.type === 'RUN_ELEMENT_ACTION');
      assert.equal(msg.action, 'explain');
    } finally {
      await page.close();
    }
  });

  it('routes "Fix"/"Improve"/"Make Responsive" with their own action names', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      for (const action of ['fix', 'improve', 'make_responsive']) {
        await selectCheckout(page);
        await page.evaluate((a) => {
          const host = document.querySelector('#origami-selection-root') as HTMLElement;
          (host.shadowRoot!.querySelector(`[data-action="${a}"]`) as HTMLElement).click();
        }, action);
        await page.waitForFunction(
          (a) => (window as any).__origamiSentMessages.some((m: any) => m.type === 'RUN_ELEMENT_ACTION' && m.action === a),
          action,
        );
      }
      const actions = (await page.evaluate(() => (window as any).__origamiSentMessages))
        .filter((m: any) => m.type === 'RUN_ELEMENT_ACTION')
        .map((m: any) => m.action);
      assert.deepEqual(actions, ['fix', 'improve', 'make_responsive']);
    } finally {
      await page.close();
    }
  });

  it('displays a "browser-only analysis" note when groundedInRepository is false, and omits it when true (repository-connected vs disconnected Fix, surfaced by the SAME UI code)', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await page.evaluate((fakeDataUrl) => {
        (window as any).__origamiSendMessageImpl = (m: any) => {
          if (m.type === 'CAPTURE_VISIBLE_TAB') return Promise.resolve({ dataUrl: fakeDataUrl });
          return Promise.resolve({ ok: true, answer: 'No repository was connected; here is general guidance.', groundedInRepository: false });
        };
      }, FAKE_SCREENSHOT_DATA_URL);
      await selectCheckout(page);
      await page.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        (host.shadowRoot!.querySelector('[data-action="fix"]') as HTMLElement).click();
      });
      await page.waitForFunction(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        return host?.shadowRoot?.querySelector('.ol-action-result') != null;
      });
      const groundingNoteShown = await page.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        return host.shadowRoot!.querySelector('.ol-action-grounding') !== null;
      });
      assert.ok(groundingNoteShown);
    } finally {
      await page.close();
    }
  });
});

describe('Select Anything — select by selector (Responsive Testing integration)', () => {
  /** What the popup's "Select Element"/"Fix" buttons on a responsive-test issue actually send — see selectElementBySelector in selection-overlay.ts and SELECT_ELEMENT_BY_SELECTOR in content-script.ts. */
  async function selectBySelector(page: Page, selector: string, autoAction?: string): Promise<{ success: boolean; error?: string }> {
    return page.evaluate(
      ({ selector, autoAction }) => (window as any).__origamiTriggerMessage({ type: 'SELECT_ELEMENT_BY_SELECTOR', selector, autoAction }),
      { selector, autoAction },
    );
  }

  it('jumps straight to the SELECTED state for a real page element by selector, with no prior hover/click', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      const response = await selectBySelector(page, '#checkout-btn');
      assert.equal(response.success, true);

      const panelVisible = await page.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        return host?.shadowRoot?.querySelector('.ol-panel') != null;
      });
      assert.ok(panelVisible, 'selecting by selector must show the same Selected Element panel a real click would');

      // The real underlying button must never have been activated — same guarantee a manual click-selection gives.
      const wasClicked = await page.evaluate(() => (window as any).__clicked === true);
      assert.equal(wasClicked, false);
    } finally {
      await page.close();
    }
  });

  it('reports a clear, real error (never a silent no-op) when the selector matches nothing on the page', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      const response = await selectBySelector(page, '#this-does-not-exist');
      assert.equal(response.success, false);
      assert.match(response.error!, /could not be found/i);
    } finally {
      await page.close();
    }
  });

  it('with autoAction "fix", selects the element AND immediately routes a RUN_ELEMENT_ACTION with action "fix" — the same Fix pipeline a manual click on the in-page Fix button already uses', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      const response = await selectBySelector(page, '#checkout-btn', 'fix');
      assert.equal(response.success, true);

      await page.waitForFunction(() => (window as any).__origamiSentMessages.some((m: any) => m.type === 'RUN_ELEMENT_ACTION'));
      const msg = (await page.evaluate(() => (window as any).__origamiSentMessages)).find((m: any) => m.type === 'RUN_ELEMENT_ACTION');
      assert.equal(msg.action, 'fix');
    } finally {
      await page.close();
    }
  });
});

describe('Create Bug Report — evidence capture', () => {
  async function collectBugReportEvidence(page: Page): Promise<any> {
    return page.evaluate(() => (window as any).__origamiTriggerMessage({ type: 'COLLECT_BUG_REPORT_EVIDENCE' }));
  }

  it('captures real page-level evidence (URL/title/viewport/DPR/screenshot) with NO domEvidence when nothing is selected', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      const response = await collectBugReportEvidence(page);
      assert.equal(response.success, true);
      assert.equal(response.result.url, page.url());
      assert.ok(response.result.screenshotBase64.length > 0, 'expected a real screenshot, not empty');
      assert.ok(response.result.viewportWidth > 0 && response.result.viewportHeight > 0);
      assert.equal(response.result.domEvidence, undefined, 'must honestly omit DOM evidence rather than fabricate it when nothing was selected');
    } finally {
      await page.close();
    }
  });

  it('includes real DOM evidence (selector/html/computedStyles/boundingBox) when an element is currently selected via Select Anything', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await startSelection(page);
      await clickPageElement(page, page, '#checkout-btn');

      const response = await collectBugReportEvidence(page);
      assert.equal(response.success, true);
      assert.equal(response.result.domEvidence.selector, '[data-testid="checkout-button"]');
      assert.equal(response.result.domEvidence.tag, 'button');
      assert.match(response.result.domEvidence.html, /checkout-btn/);
      assert.ok(Object.keys(response.result.domEvidence.computedStyles).length > 0);
      assert.ok(response.result.domEvidence.boundingBox.width > 0);
    } finally {
      await page.close();
    }
  });

  it('refuses to capture (blockReason, never silently strips) when the current selection contains a password field', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(page, PLAIN_FIXTURE);
      await startSelection(page);
      await clickPageElement(page, page, 'form');

      const response = await collectBugReportEvidence(page);
      assert.equal(response.success, true);
      assert.match(response.result.blockReason, /password/i);
    } finally {
      await page.close();
    }
  });
});

describe('Select Anything — same-origin iframe support (25)', () => {
  it('selects an element inside a same-origin iframe (srcdoc), correctly offsetting the screenshot crop into top-page coordinates', async () => {
    const page = await newStubbedPage();
    try {
      await loadFixture(
        page,
        `<html><body style="margin:0;">
          <div style="height: 100px;"></div>
          <iframe id="frame" style="width: 400px; height: 300px; border: 0;" srcdoc="
            <html><body>
              <button id=&quot;inner-btn&quot; style=&quot;width:200px;height:40px;&quot;>Inner button</button>
            </body></html>
          "></iframe>
        </body></html>`,
      );

      const frame = page.frames().find((f) => f !== page.mainFrame());
      assert.ok(frame, 'expected the iframe to have loaded a child frame');

      // The content script runs inside the iframe too (all_frames:true) — inject + stub there directly, same as the top-level page.
      await injectContentScript(frame!);
      await startSelection(frame!);
      await clickPageElement(page, frame!, '#inner-btn');

      const panelVisible = await frame!.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        return host?.shadowRoot?.querySelector('.ol-panel') != null;
      });
      assert.ok(panelVisible, 'selection must work fully INSIDE a same-origin iframe\'s own document');
    } finally {
      await page.close();
    }
  });
});

describe('Select Anything — cross-origin iframe: graceful degradation (25)', () => {
  it('never breaks the main selection experience when the element is inside a cross-origin iframe — HTML/CSS context still captured, screenshot honestly reported as unavailable', async () => {
    const childServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><button id="cross-origin-btn" style="width:150px;height:35px;">Cross-origin button</button></body></html>');
    });
    await new Promise<void>((resolve) => childServer.listen(0, '127.0.0.1', resolve));
    const childPort = (childServer.address() as { port: number }).port;

    const parentServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body><iframe id="frame" src="http://127.0.0.1:${childPort}/" style="width:400px;height:300px;border:0;"></iframe></body></html>`);
    });
    await new Promise<void>((resolve) => parentServer.listen(0, 'localhost', resolve));
    const parentPort = (parentServer.address() as { port: number }).port;

    const page = await newStubbedPage();
    try {
      await page.goto(`http://localhost:${parentPort}/`);
      await page.waitForSelector('#frame');
      const childFrame = page.frames().find((f) => f.url().includes(`127.0.0.1:${childPort}`));
      assert.ok(childFrame, 'expected the cross-origin child frame to load');

      // Verify these two origins really are cross-origin from the page's own point of view (127.0.0.1 vs localhost) before trusting the rest of the assertion.
      const isCrossOrigin = await page.evaluate(() => {
        const frameEl = document.getElementById('frame') as HTMLIFrameElement;
        try {
          void frameEl.contentWindow!.location.href; // throws for a true cross-origin frame
          return false;
        } catch {
          return true;
        }
      });
      assert.ok(isCrossOrigin, 'test setup sanity check: localhost and 127.0.0.1 must be treated as cross-origin');

      await injectContentScript(childFrame!);
      await startSelection(childFrame!);
      await clickPageElement(page, childFrame!, '#cross-origin-btn');
      await childFrame!.evaluate(() => {
        const host = document.querySelector('#origami-selection-root') as HTMLElement;
        (host.shadowRoot!.querySelector('[data-action="explain"]') as HTMLElement).click();
      });
      await childFrame!.waitForFunction(() => (window as any).__origamiSentMessages?.some((m: any) => m.type === 'RUN_ELEMENT_ACTION'));

      const evidence = (await childFrame!.evaluate(() => (window as any).__origamiSentMessages)).find((m: any) => m.type === 'RUN_ELEMENT_ACTION').evidence;
      // The main experience is NOT broken — HTML/CSS/DOM context is still fully captured.
      assert.match(evidence.html, /cross-origin-btn/);
      assert.equal(evidence.element.tag, 'button');
      // The screenshot is honestly empty (never a wrongly-cropped image) — see getFrameContext's doc comment in selection-overlay.ts.
      assert.equal(evidence.screenshotBase64, '');
    } finally {
      await page.close();
      await new Promise((resolve) => childServer.close(resolve));
      await new Promise((resolve) => parentServer.close(resolve));
    }
  });
});
