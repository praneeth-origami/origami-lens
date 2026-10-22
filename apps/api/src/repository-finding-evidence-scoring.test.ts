import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { correlateEvidenceWithText, deriveFixSourceGrounding } from './repository-finding-evidence-scoring.js';
import { extractEvidenceTokens } from './repository-finding-evidence.js';

describe('correlateEvidenceWithText', () => {
  it('finds a structural (class) match and reports it', () => {
    const tokens = extractEvidenceTokens({ selector: 'button.theme-option.active' });
    const result = correlateEvidenceWithText(tokens, 'export function ThemeSelector() { return <button className="theme-option active">{label}</button>; }');
    assert.equal(result.hasStructuralMatch, true);
    assert.ok(result.matchedTokens.includes('theme-option'));
  });

  it('finds no match against unrelated content', () => {
    const tokens = extractEvidenceTokens({ selector: 'button.theme-option.active' });
    const result = correlateEvidenceWithText(tokens, 'export function Footer() { return <footer>copyright</footer>; }');
    assert.equal(result.score, 0);
    assert.deepEqual(result.matchedTokens, []);
  });

  it('weights a structural match higher than an equal-count text-only match', () => {
    const structuralTokens = extractEvidenceTokens({ selector: 'button.theme-option' });
    const textOnlyTokens = extractEvidenceTokens({ snippet: '<span>alpha bravo</span>' });
    const structural = correlateEvidenceWithText(structuralTokens, 'export function X() { return <button className="theme-option">y</button>; }');
    const textOnly = correlateEvidenceWithText(textOnlyTokens, 'alpha bravo charlie');
    assert.equal(structural.matchedTokens.length, 2);
    assert.equal(textOnly.matchedTokens.length, 2);
    assert.ok(structural.score > textOnly.score);
  });
});

describe('deriveFixSourceGrounding', () => {
  it('TEST 1 — a structural match with no competing alternative is HIGH confidence', () => {
    const tokens = extractEvidenceTokens({ selector: 'button.theme-option.active' });
    const selected = correlateEvidenceWithText(tokens, '<button class="theme-option active">Dark</button>');
    const grounding = deriveFixSourceGrounding(true, selected, undefined);
    assert.equal(grounding.confidence, 'HIGH');
    assert.ok(grounding.matchedEvidence.length > 0);
    assert.equal(grounding.note, undefined);
  });

  it('TEST 2 — a similar but incorrect component (better-matching alternative) ranks lower than the selected file', () => {
    const tokens = extractEvidenceTokens({ selector: 'button.theme-option.active' });
    // the selected file only weakly correlates...
    const selected = correlateEvidenceWithText(tokens, 'export function GenericButton() { return <button className="btn">{children}</button>; }');
    // ...while a different retrieved file matches strongly.
    const alternative = correlateEvidenceWithText(tokens, 'export function ThemeSelector() { return <button className="theme-option active">Dark</button>; }');
    const grounding = deriveFixSourceGrounding(true, selected, alternative);
    assert.equal(grounding.confidence, 'MEDIUM');
    assert.match(grounding.note ?? '', /review carefully/i);
  });

  it('TEST 3 — visible text alone is a weaker (MEDIUM) signal', () => {
    const tokens = extractEvidenceTokens({ snippet: '<span>Upgrade to continue</span>' });
    const selected = correlateEvidenceWithText(tokens, 'const message = "Upgrade to continue";');
    const grounding = deriveFixSourceGrounding(true, selected, undefined);
    assert.equal(grounding.confidence, 'MEDIUM');
  });

  it('TEST 4 — data-testid helps reach HIGH confidence', () => {
    const tokens = extractEvidenceTokens({ snippet: '<button data-testid="theme-toggle">Dark</button>' });
    const selected = correlateEvidenceWithText(tokens, '<button data-testid="theme-toggle" onClick={toggle}>{label}</button>');
    const grounding = deriveFixSourceGrounding(true, selected, undefined);
    assert.equal(grounding.confidence, 'HIGH');
  });

  it('TEST 6 — a semantically similar but unrelated file (zero token overlap) is not treated as high confidence', () => {
    const tokens = extractEvidenceTokens({ selector: 'button.theme-option.active' });
    const selected = correlateEvidenceWithText(tokens, 'export function UnrelatedWidget() { return <div>hello</div>; }');
    const grounding = deriveFixSourceGrounding(true, selected, undefined);
    assert.equal(grounding.confidence, 'LOW');
    assert.deepEqual(grounding.matchedEvidence, []);
  });

  it('TEST 7 — low confidence is surfaced with an explanatory note, never silently upgraded', () => {
    const grounding = deriveFixSourceGrounding(false, { score: 0, matchedTokens: [], hasStructuralMatch: false }, undefined);
    assert.equal(grounding.confidence, 'LOW');
    assert.ok(grounding.note && grounding.note.length > 0);
  });
});
