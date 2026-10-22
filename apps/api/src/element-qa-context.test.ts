import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentDomNode, ComponentEvidence } from '@origami/contracts';
import { buildElementQaContext } from './element-qa-context.js';

function fakeNode(overrides: Partial<ComponentDomNode> = {}): ComponentDomNode {
  return {
    tag: 'button',
    selector: 'button.checkout-btn',
    attributes: {},
    style: {},
    boundingBox: { x: 0, y: 0, width: 100, height: 40 },
    children: [],
    ...overrides,
  };
}

function fakeEvidence(overrides: Partial<ComponentEvidence> = {}): ComponentEvidence {
  return {
    sourceUrl: 'https://example.com/settings',
    pageTitle: 'Settings',
    capturedAt: new Date().toISOString(),
    boundingBox: { x: 0, y: 0, width: 100, height: 40, devicePixelRatio: 1, scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 720 },
    screenshotBase64: 'ZmFrZQ==',
    element: fakeNode(),
    ancestors: [],
    html: '<button class="checkout-btn"></button>',
    cssVariables: {},
    assets: [],
    containsSensitiveFields: false,
    ...overrides,
  };
}

describe('buildElementQaContext — accessibility context (roadmap: Select Anything)', () => {
  it('surfaces the computed accessible name, role, aria-* attributes, disabled, and tabindex when captured', () => {
    const evidence = fakeEvidence({
      element: fakeNode({
        attributes: {
          role: 'button',
          'aria-expanded': 'false',
          'aria-hidden': 'false',
          disabled: '',
          tabindex: '0',
          'data-origami-accessible-name': 'Checkout',
        },
      }),
    });
    const context = buildElementQaContext({ url: evidence.sourceUrl, evidence });
    assert.match(context, /Accessibility:/);
    assert.match(context, /accessible name: "Checkout"/);
    assert.match(context, /role: button/);
    assert.match(context, /aria-expanded: false/);
    assert.match(context, /aria-hidden: false/);
    assert.match(context, /disabled/);
    assert.match(context, /tabindex: 0/);
  });

  it('omits the Accessibility line entirely when the element has no accessibility-relevant attributes', () => {
    const context = buildElementQaContext({ url: 'https://example.com', evidence: fakeEvidence({ element: fakeNode({ attributes: {} }) }) });
    assert.ok(!context.includes('Accessibility:'));
  });

  it('scrubs the accessible name and aria attribute values through the privacy scrubber, defense in depth', () => {
    const evidence = fakeEvidence({
      element: fakeNode({
        attributes: {
          'data-origami-accessible-name': 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.abcdefghijklmnopqrstuvwxyz012345',
        },
      }),
    });
    const context = buildElementQaContext({ url: evidence.sourceUrl, evidence });
    assert.ok(!context.includes('eyJhbGciOiJIUzI1NiJ9'), 'a JWT-shaped accessible name must be scrubbed, never echoed verbatim');
  });

  it('never includes the "value" attribute even if a caller somehow still supplied one (defense in depth alongside the extension\'s own capture-time exclusion)', () => {
    const evidence = fakeEvidence({ element: fakeNode({ attributes: { value: 'super-secret-typed-text' } }) });
    const context = buildElementQaContext({ url: evidence.sourceUrl, evidence });
    assert.ok(!context.includes('super-secret-typed-text'));
  });
});
