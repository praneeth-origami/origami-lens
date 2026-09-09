import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OrigamiRuleEngine } from './index.js';
import type { BrowserEvidence } from '@origami/contracts';

function baseEvidence(overrides: Partial<BrowserEvidence> = {}): BrowserEvidence {
  return {
    page: { url: 'https://example.com', title: 'Test Page', description: 'A description' },
    documentDimensions: { width: 1200, height: 800 },
    viewport: { width: 1280, height: 720 },
    dom: { headings: [{ selector: 'h1', tag: 'h1', text: 'Title', attributes: {} }], images: [], links: [], buttons: [], forms: [], iframes: [] },
    layout: { horizontalOverflow: false, elementsOutsideViewport: [], fixedWidthElements: [] },
    console: [],
    network: [],
    performance: {},
    screenshots: [],
    collectedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('OrigamiRuleEngine', () => {
  const engine = new OrigamiRuleEngine();

  it('detects missing title', () => {
    const issues = engine.evaluate(baseEvidence({ page: { url: 'https://example.com', title: '' } }));
    assert.ok(issues.some((i) => i.type === 'MISSING_TITLE'));
  });

  it('detects missing image alt', () => {
    const issues = engine.evaluate(baseEvidence({
      dom: {
        ...baseEvidence().dom,
        images: [{ selector: 'img', tag: 'img', attributes: { src: '/a.png' } }],
      },
    }));
    assert.ok(issues.some((i) => i.type === 'MISSING_IMAGE_ALT'));
  });

  it('detects empty button', () => {
    const issues = engine.evaluate(baseEvidence({
      dom: {
        ...baseEvidence().dom,
        buttons: [{ selector: 'button', tag: 'button', text: '', attributes: {} }],
      },
    }));
    assert.ok(issues.some((i) => i.type === 'EMPTY_BUTTON'));
  });

  it('detects console errors', () => {
    const issues = engine.evaluate(baseEvidence({
      console: [{ type: 'error', message: 'Uncaught Error', timestamp: Date.now() }],
    }));
    assert.ok(issues.some((i) => i.type === 'CONSOLE_ERROR'));
  });

  it('detects horizontal overflow', () => {
    const issues = engine.evaluate(baseEvidence({
      layout: { horizontalOverflow: true, overflowWidth: 500, elementsOutsideViewport: [], fixedWidthElements: [] },
    }));
    assert.ok(issues.some((i) => i.type === 'HORIZONTAL_OVERFLOW'));
  });

  it('detects mixed content', () => {
    const issues = engine.evaluate(baseEvidence({
      page: { url: 'https://example.com', title: 'Secure' },
      network: [{ url: 'http://insecure.example.com/script.js', method: 'GET', status: 200, duration: 0, resourceType: 'script' }],
    }));
    assert.ok(issues.some((i) => i.type === 'MIXED_CONTENT'));
  });

  it('skips form label rule when label[for] is present', () => {
    const issues = engine.evaluate(baseEvidence({
      dom: {
        ...baseEvidence().dom,
        forms: [{
          selector: '#email',
          tag: 'input',
          attributes: { id: 'email', type: 'email' },
          hasAssociatedLabel: true,
          labelText: 'Email address',
        }],
      },
    }));
    assert.ok(!issues.some((i) => i.type === 'MISSING_FORM_LABEL'));
  });

  it('flags missing form label when no association exists', () => {
    const issues = engine.evaluate(baseEvidence({
      dom: {
        ...baseEvidence().dom,
        forms: [{
          selector: 'input',
          tag: 'input',
          attributes: { type: 'text' },
          hasAssociatedLabel: false,
        }],
      },
    }));
    assert.ok(issues.some((i) => i.type === 'MISSING_FORM_LABEL'));
  });
});
