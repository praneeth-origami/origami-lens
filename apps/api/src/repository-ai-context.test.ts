import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_REPOSITORY_QA_MAX_CHUNK_CHARS,
  AI_REPOSITORY_QA_MAX_CONTEXT_CHARS,
  buildRepositoryQaContext,
  formatContextBlock,
  type RepositoryContextChunk,
} from './repository-ai-context.js';

function makeChunk(overrides: Partial<RepositoryContextChunk> = {}): RepositoryContextChunk {
  return {
    filePath: 'packages/scoring/src/index.ts', language: 'typescript', symbol: 'calculateHealthScore',
    symbolType: 'function', startLine: 42, endLine: 96, content: 'function calculateHealthScore() { return 1; }',
    ...overrides,
  };
}

describe('formatContextBlock', () => {
  it('produces the documented deterministic format with a Code: label', () => {
    const block = formatContextBlock(makeChunk());
    assert.match(block, /^File: packages\/scoring\/src\/index\.ts\n/);
    assert.match(block, /Language: typescript/);
    assert.match(block, /Symbol: calculateHealthScore/);
    assert.match(block, /Symbol Type: function/);
    assert.match(block, /Lines: 42-96/);
    assert.match(block, /\nCode:\nfunction calculateHealthScore/);
  });

  it('is fully deterministic — the same chunk always produces the exact same block', () => {
    assert.equal(formatContextBlock(makeChunk()), formatContextBlock({ ...makeChunk() }));
  });

  it('scrubs an accidentally-committed secret out of chunk content', () => {
    const block = formatContextBlock(makeChunk({ content: 'const token = "Bearer sk-abcdefghijklmnopqrstuvwxyz123456";' }));
    assert.ok(!block.includes('sk-abcdefghijklmnopqrstuvwxyz123456'));
  });

  it('truncates a single chunk to AI_REPOSITORY_QA_MAX_CHUNK_CHARS rather than sending it unbounded', () => {
    const huge = 'x'.repeat(AI_REPOSITORY_QA_MAX_CHUNK_CHARS + 5000);
    const block = formatContextBlock(makeChunk({ content: huge }));
    assert.ok(block.length < huge.length);
  });
});

describe('buildRepositoryQaContext', () => {
  it('includes chunks in the given (ranked) order, highest-ranked first', () => {
    const chunks = [
      makeChunk({ symbol: 'first', content: 'a' }),
      makeChunk({ symbol: 'second', content: 'b' }),
      makeChunk({ symbol: 'third', content: 'c' }),
    ];
    const { includedChunks } = buildRepositoryQaContext(chunks);
    assert.deepEqual(includedChunks.map((c) => c.symbol), ['first', 'second', 'third']);
  });

  it('preserves complete chunks — never truncates a chunk mid-string to fit the remaining budget', () => {
    const bigButUnderChunkCap = 'y'.repeat(AI_REPOSITORY_QA_MAX_CHUNK_CHARS - 100);
    const chunks = Array.from({ length: 10 }, (_, i) => makeChunk({ symbol: `fn${i}`, content: bigButUnderChunkCap }));
    const { contextText, includedChunks } = buildRepositoryQaContext(chunks);
    for (const chunk of includedChunks) {
      assert.ok(contextText.includes(bigButUnderChunkCap), 'every included chunk\'s full content must appear verbatim, never cut mid-string');
    }
  });

  it('never exceeds AI_REPOSITORY_QA_MAX_CONTEXT_CHARS once more than one chunk has been included', () => {
    const chunks = Array.from({ length: 20 }, (_, i) => makeChunk({ symbol: `fn${i}`, content: 'z'.repeat(2000) }));
    const { contextText, includedChunks } = buildRepositoryQaContext(chunks);
    assert.ok(includedChunks.length < chunks.length, 'the budget must actually stop lower-ranked chunks from being included');
    assert.ok(contextText.length <= AI_REPOSITORY_QA_MAX_CONTEXT_CHARS + 500, 'total context size must stay close to the configured budget');
  });

  it('always includes the single highest-ranked chunk even if it alone would exceed the remaining budget', () => {
    const enormousFirstChunk = makeChunk({ symbol: 'mostRelevant', content: 'a'.repeat(AI_REPOSITORY_QA_MAX_CHUNK_CHARS) });
    const { includedChunks } = buildRepositoryQaContext([enormousFirstChunk]);
    assert.equal(includedChunks.length, 1);
    assert.equal(includedChunks[0].symbol, 'mostRelevant');
  });

  it('stops including a lower-ranked chunk once the accumulated budget is exhausted, never reordering to fit a smaller later chunk first', () => {
    // Each chunk is individually under AI_REPOSITORY_QA_MAX_CHUNK_CHARS (so
    // the per-chunk cap never kicks in here), but enough of them together
    // exceed AI_REPOSITORY_QA_MAX_CONTEXT_CHARS — the accumulated-budget
    // check (not the per-chunk cap) is what must exclude the tail.
    const perChunkSize = AI_REPOSITORY_QA_MAX_CHUNK_CHARS - 500;
    const bigChunks = Array.from({ length: 4 }, (_, i) => makeChunk({ symbol: `big${i}`, content: 'b'.repeat(perChunkSize) }));
    const tinyLastRanked = makeChunk({ symbol: 'tiny', content: 'x' });
    const { includedChunks } = buildRepositoryQaContext([...bigChunks, tinyLastRanked]);
    assert.ok(!includedChunks.some((c) => c.symbol === 'tiny'), 'the lowest-ranked chunk must be dropped once the running total already exceeds the budget');
    assert.deepEqual(includedChunks.map((c) => c.symbol), bigChunks.slice(0, includedChunks.length).map((c) => c.symbol), 'chunks must stay in rank order, never reordered to fit a smaller one in');
  });

  it('returns empty context and an empty chunk list for an empty input', () => {
    const { contextText, includedChunks } = buildRepositoryQaContext([]);
    assert.equal(contextText, '');
    assert.deepEqual(includedChunks, []);
  });
});
