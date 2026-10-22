import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvidence, sanitizeForAi, detectBlockingSensitiveContent, sanitizeComponentEvidence, scrubString } from './index.js';
import type { BrowserEvidence, ComponentDomNode, ComponentEvidence } from '@origami/contracts';

const baseEvidence: BrowserEvidence = {
  page: { url: 'https://example.com', title: 'Test' },
  documentDimensions: { width: 1200, height: 800 },
  viewport: { width: 1280, height: 720 },
  dom: { headings: [], images: [], links: [], buttons: [], forms: [], iframes: [] },
  layout: { horizontalOverflow: false, elementsOutsideViewport: [], fixedWidthElements: [] },
  console: [],
  network: [],
  performance: {},
  screenshots: [],
  collectedAt: new Date().toISOString(),
};

describe('PrivacyScrubber', () => {
  it('removes JWT tokens from console messages', () => {
    const evidence = sanitizeEvidence({
      ...baseEvidence,
      console: [{ type: 'log', message: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', timestamp: Date.now() }],
    });
    assert.ok(!evidence.console[0].message.includes('eyJ'));
    assert.match(evidence.console[0].message, /REDACTED/);
  });

  it('redacts password form values', () => {
    const evidence = sanitizeEvidence({
      ...baseEvidence,
      dom: {
        ...baseEvidence.dom,
        forms: [{ selector: '#pwd', tag: 'input', attributes: { type: 'password', value: 'secret123' } }],
      },
    });
    assert.equal(evidence.dom.forms[0].attributes.value, '[REDACTED]');
  });

  it('redacts authorization headers in network URLs', () => {
    const payload = sanitizeForAi({
      header: 'Authorization: Bearer abc123token',
      cookie: 'session=abc',
    });
    assert.equal(payload.cookie, '[REDACTED]');
  });

  // Found auditing Create Bug Report: scrubString previously only matched
  // specific VALUE shapes (JWT/Bearer/sk-.../email/card number), so a
  // `?token=`/`password=` query param or free-text pair embedded in a
  // network error's URL or a console error's message passed through
  // completely untouched.
  describe('scrubString — sensitive key=value pairs (bugfix: previously untouched)', () => {
    it('redacts a token query parameter in a URL', () => {
      const result = scrubString('https://example.com/api/cart?token=secret123&id=5');
      assert.ok(!result.includes('secret123'));
      assert.match(result, /token=\[REDACTED\]/);
      assert.ok(result.includes('id=5'), 'an unrelated query param must be left alone');
    });

    it('redacts a password=value pair inside a free-text console message', () => {
      const result = scrubString("Cannot read properties of undefined (reading 'foo') password=hunter2");
      assert.ok(!result.includes('hunter2'));
      assert.match(result, /password=\[REDACTED\]/);
    });

    it('redacts an api_key value', () => {
      const result = scrubString('https://api.example.com/v1/x?api_key=sk_live_abcdef123456');
      assert.ok(!result.includes('sk_live_abcdef123456'));
    });

    it('redacts a session id in "key: value" form', () => {
      const result = scrubString('session: 9f8e7d6c5b4a');
      assert.ok(!result.includes('9f8e7d6c5b4a'));
    });

    it('leaves ordinary, non-sensitive query parameters untouched', () => {
      const result = scrubString('https://example.com/search?query=shoes&page=2');
      assert.equal(result, 'https://example.com/search?query=shoes&page=2');
    });
  });
});

function makeNode(partial: Partial<ComponentDomNode>): ComponentDomNode {
  return {
    tag: 'div',
    selector: 'div',
    attributes: {},
    style: {},
    boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    children: [],
    ...partial,
  };
}

function makeComponentEvidence(element: ComponentDomNode): ComponentEvidence {
  return {
    sourceUrl: 'https://example.com/pricing',
    capturedAt: new Date().toISOString(),
    boundingBox: { x: 0, y: 0, width: 100, height: 100, devicePixelRatio: 1, scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 720 },
    screenshotBase64: 'ZmFrZQ==',
    element,
    ancestors: [],
    html: '<div></div>',
    cssVariables: {},
    assets: [],
    containsSensitiveFields: false,
  };
}

describe('Screenshot -> Code privacy guard', () => {
  it('blocks a selection containing a password field', () => {
    const el = makeNode({
      children: [makeNode({ tag: 'input', attributes: { type: 'password', name: 'pwd' } })],
    });
    const reason = detectBlockingSensitiveContent(makeComponentEvidence(el));
    assert.ok(reason);
    assert.match(reason!, /password/);
  });

  it('blocks a selection containing a card-number autocomplete field', () => {
    const el = makeNode({
      children: [makeNode({ tag: 'input', attributes: { autocomplete: 'cc-number' } })],
    });
    const reason = detectBlockingSensitiveContent(makeComponentEvidence(el));
    assert.ok(reason);
  });

  it('allows a plain pricing-card selection', () => {
    const el = makeNode({
      children: [makeNode({ tag: 'button', text: 'Buy now', attributes: { class: 'btn' } })],
    });
    const reason = detectBlockingSensitiveContent(makeComponentEvidence(el));
    assert.equal(reason, null);
  });

  it('redacts emails and card-shaped numbers in component HTML/text', () => {
    const el = makeNode({ text: 'Contact user@example.com or call re: card 4111 1111 1111 1111' });
    const evidence = sanitizeComponentEvidence(makeComponentEvidence(el));
    assert.ok(!evidence.element.text!.includes('user@example.com'));
    assert.ok(!evidence.element.text!.includes('4111'));
  });
});
