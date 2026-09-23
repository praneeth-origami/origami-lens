import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_REPOSITORY_FIX_MAX_CONTEXT_CHARS,
  buildFindingFixContext,
  buildFindingSearchQuery,
  summarizeFindingEvidence,
  type FindingSummary,
} from './repository-fix-context.js';
import type { RepositoryContextChunk } from './repository-ai-context.js';

const SAMPLE_FINDING: FindingSummary = {
  title: 'Warning banner text has insufficient color contrast',
  severity: 'MEDIUM',
  category: 'accessibility',
  description: 'The banner background does not meet WCAG contrast requirements.',
  evidence: 'selector: .health-banner-warning',
};

function makeChunk(overrides: Partial<RepositoryContextChunk> = {}): RepositoryContextChunk {
  return {
    filePath: 'apps/web/src/styles/dashboard.css', language: 'css', symbol: '.health-banner-warning',
    symbolType: 'rule', startLine: 120, endLine: 125, content: '.health-banner-warning { background: #ffffff; }',
    ...overrides,
  };
}

describe('buildFindingSearchQuery', () => {
  it('TEST 6 — combines title, category, selector, and evidence message into a bounded deterministic query', () => {
    const query = buildFindingSearchQuery({
      title: 'Warning banner text has insufficient color contrast', category: 'accessibility',
      evidence: { selector: '.health-banner-warning', message: 'Contrast ratio 2.1:1, required 4.5:1' },
    });
    assert.match(query, /Warning banner text has insufficient color contrast/);
    assert.match(query, /accessibility/);
    assert.match(query, /\.health-banner-warning/);
    assert.ok(query.length <= 300);
  });

  it('does not blindly concatenate the entire scan payload — only title/category/selector/message', () => {
    const query = buildFindingSearchQuery({ title: 'T', category: 'seo', evidence: { selector: 's', message: 'm', snippet: 'this should not appear' } as never });
    assert.ok(!query.includes('this should not appear'));
  });

  it('is deterministic — the same finding always produces the exact same query', () => {
    const finding = { title: 'T', category: 'seo', evidence: { selector: 's' } };
    assert.equal(buildFindingSearchQuery(finding), buildFindingSearchQuery({ ...finding }));
  });

  it('omits missing evidence fields cleanly rather than inserting "undefined"', () => {
    const query = buildFindingSearchQuery({ title: 'T', category: 'seo' });
    assert.ok(!query.includes('undefined'));
  });
});

describe('summarizeFindingEvidence', () => {
  it('formats known evidence fields', () => {
    const text = summarizeFindingEvidence({ selector: '.foo', message: 'bad contrast' });
    assert.match(text, /selector: \.foo/);
    assert.match(text, /message: bad contrast/);
  });

  it('returns a placeholder for missing evidence', () => {
    assert.equal(summarizeFindingEvidence(undefined), '(none)');
  });

  it('scrubs an accidentally-captured secret out of evidence text', () => {
    const text = summarizeFindingEvidence({ message: 'token=Bearer sk-abcdefghijklmnopqrstuvwxyz123456 leaked' });
    assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwxyz123456'));
  });
});

describe('buildFindingFixContext', () => {
  it('includes a FINDING section with the title/severity/category/description/evidence', () => {
    const { contextText } = buildFindingFixContext(SAMPLE_FINDING, [makeChunk()]);
    assert.match(contextText, /^FINDING/);
    assert.match(contextText, /Title:\nWarning banner text has insufficient color contrast/);
    assert.match(contextText, /Severity:\nMEDIUM/);
    assert.match(contextText, /Category:\naccessibility/);
    assert.match(contextText, /Evidence:\nselector: \.health-banner-warning/);
  });

  it('includes a REPOSITORY CONTEXT section with the ranked chunks', () => {
    const { contextText, includedChunks } = buildFindingFixContext(SAMPLE_FINDING, [makeChunk()]);
    assert.match(contextText, /REPOSITORY CONTEXT/);
    assert.match(contextText, /File: apps\/web\/src\/styles\/dashboard\.css/);
    assert.equal(includedChunks.length, 1);
  });

  it('TEST 11 — enforces a context budget, never sending the entire repository', () => {
    const manyChunks = Array.from({ length: 20 }, (_, i) => makeChunk({ symbol: `.rule${i}`, content: 'x'.repeat(2000) }));
    const { includedChunks } = buildFindingFixContext(SAMPLE_FINDING, manyChunks);
    assert.ok(includedChunks.length < manyChunks.length);
  });

  it('handles zero retrieved chunks without throwing', () => {
    const { contextText, includedChunks } = buildFindingFixContext(SAMPLE_FINDING, []);
    assert.deepEqual(includedChunks, []);
    assert.match(contextText, /no relevant repository context was retrieved/);
  });
});
