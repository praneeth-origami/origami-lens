import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceTokensForQuery, extractEvidenceTokens } from './repository-finding-evidence.js';

describe('extractEvidenceTokens', () => {
  it('parses a tag+class selector into structural tokens', () => {
    const tokens = extractEvidenceTokens({ selector: 'button.theme-option.active' });
    assert.ok(tokens.structural.includes('button'));
    assert.ok(tokens.structural.includes('theme-option'));
    assert.ok(tokens.structural.includes('active'));
    assert.equal(tokens.hasAny, true);
  });

  it('parses an id selector', () => {
    const tokens = extractEvidenceTokens({ selector: '#main-nav' });
    assert.ok(tokens.structural.includes('main-nav'));
  });

  it('ignores a bare-tag snippet (no real markup) beyond what the selector already gave', () => {
    const tokens = extractEvidenceTokens({ selector: 'button', snippet: 'button' });
    assert.deepEqual(tokens.text, []);
  });

  it('pulls class/tag/text tokens out of a real HTML snippet', () => {
    const tokens = extractEvidenceTokens({ snippet: '<button class="theme-option active">Dark</button>' });
    assert.ok(tokens.structural.includes('button'));
    assert.ok(tokens.structural.includes('theme-option'));
    assert.ok(tokens.structural.includes('active'));
    assert.ok(tokens.text.includes('dark'));
  });

  it('pulls data-testid out of a real HTML snippet as a structural token', () => {
    const tokens = extractEvidenceTokens({ snippet: '<button data-testid="theme-toggle">Dark mode</button>' });
    assert.ok(tokens.structural.includes('theme-toggle'));
  });

  it('reads evidence from nested items[] — the only place axe-core violation evidence lives', () => {
    const tokens = extractEvidenceTokens({
      message: 'Elements must meet minimum color contrast ratio thresholds',
      count: 1,
      items: [{ selector: 'button.theme-option.active', snippet: '<button class="theme-option active">Dark</button>' }],
    });
    assert.ok(tokens.structural.includes('theme-option'));
    assert.ok(tokens.text.includes('dark'));
  });

  it('is honest about having no evidence at all', () => {
    const tokens = extractEvidenceTokens({ message: 'generic message', count: 1 });
    assert.equal(tokens.hasAny, false);
  });

  it('handles undefined evidence without throwing', () => {
    const tokens = extractEvidenceTokens(undefined);
    assert.equal(tokens.hasAny, false);
  });

  it('caps how many nested items are considered, matching the scanner\'s own cap of 3', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ selector: `#item-${i}` }));
    const tokens = extractEvidenceTokens({ items });
    assert.ok(!tokens.structural.includes('item-5'));
  });
});

describe('evidenceTokensForQuery', () => {
  it('orders structural tokens before text tokens and bounds the count', () => {
    const tokens = extractEvidenceTokens({ snippet: '<button class="theme-option active" data-testid="toggle">Switch to dark mode now</button>' });
    const list = evidenceTokensForQuery(tokens);
    assert.ok(list.length <= 12);
    const firstTextIndex = list.findIndex((t) => tokens.text.includes(t));
    const lastStructuralIndex = list.map((t) => tokens.structural.includes(t)).lastIndexOf(true);
    if (firstTextIndex !== -1 && lastStructuralIndex !== -1) {
      assert.ok(lastStructuralIndex < firstTextIndex);
    }
  });
});
