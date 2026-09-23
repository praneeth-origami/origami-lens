import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkSymbol, computeChunkKey, computeContentHash } from './repository-chunker.js';
import type { ExtractedSymbol } from './repository-ast.js';

function makeSymbol(overrides: Partial<ExtractedSymbol> = {}): ExtractedSymbol {
  return {
    symbol: 'add',
    symbolType: 'function',
    parentSymbol: null,
    startLine: 1,
    endLine: 3,
    startColumn: 0,
    endColumn: 1,
    startIndex: 0,
    endIndex: 30,
    isExported: true,
    content: 'function add(a, b) {\n  return a + b;\n}',
    ...overrides,
  };
}

const CONTEXT = { repositoryId: 'repo-1', commitSha: 'abc123', filePath: 'src/utils/math.ts', language: 'typescript' };

describe('chunkSymbol', () => {
  it('TEST 21 — a symbol within limits becomes exactly one chunk with full metadata preserved', () => {
    const symbol = makeSymbol();
    const chunks = chunkSymbol(symbol, CONTEXT);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].symbol, 'add');
    assert.equal(chunks[0].symbolType, 'function');
    assert.equal(chunks[0].startLine, 1);
    assert.equal(chunks[0].endLine, 3);
    assert.equal(chunks[0].content, symbol.content);
  });

  it('TEST 22 — nested symbols (e.g. class methods) are handled as independent chunks with the correct parentSymbol', () => {
    const method = makeSymbol({ symbol: 'getUser', symbolType: 'method', parentSymbol: 'UserService', content: 'getUser(id) {\n  return id;\n}' });
    const chunks = chunkSymbol(method, CONTEXT);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].parentSymbol, 'UserService');
  });

  it('TEST 23 — an oversized symbol is split into deterministic line-bounded child chunks', () => {
    const bigContent = Array.from({ length: 500 }, (_, i) => `  const line${i} = ${i};`).join('\n');
    const content = `function big() {\n${bigContent}\n}`;
    const symbol = makeSymbol({ symbol: 'big', startLine: 1, endLine: content.split('\n').length, content });
    const chunks = chunkSymbol(symbol, CONTEXT);
    assert.ok(chunks.length > 1, 'an oversized symbol must produce more than one chunk');

    // Every chunk stays within the configured limits.
    for (const chunk of chunks) {
      const lineCount = chunk.endLine - chunk.startLine + 1;
      assert.ok(lineCount <= 200, `chunk line count ${lineCount} exceeds the configured limit`);
      assert.ok(Buffer.byteLength(chunk.content, 'utf8') <= 4000, 'chunk byte size exceeds the configured limit');
    }

    // Line ranges are contiguous and cover the whole symbol with no gaps or overlaps.
    for (let i = 1; i < chunks.length; i++) {
      assert.equal(chunks[i].startLine, chunks[i - 1].endLine + 1);
    }
    assert.equal(chunks[0].startLine, symbol.startLine);
    assert.equal(chunks[chunks.length - 1].endLine, symbol.endLine);

    // Every sub-chunk still carries the parent symbol's metadata.
    for (const chunk of chunks) {
      assert.equal(chunk.symbol, 'big');
      assert.equal(chunk.symbolType, 'function');
    }
  });

  it('never splits content in a way that loses or duplicates any line', () => {
    const bigContent = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const symbol = makeSymbol({ startLine: 10, endLine: 309, content: bigContent });
    const chunks = chunkSymbol(symbol, CONTEXT);
    const reassembled = chunks.map((c) => c.content).join('\n');
    assert.equal(reassembled, bigContent);
  });

  it('splits on whole lines only, so a multi-byte UTF-8 character is never cut in the middle', () => {
    // Each line individually fits the byte limit, but the file as a whole
    // must span multiple chunks — every split point must land on a '\n'.
    const line = '  const emoji = "🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉";'; // multi-byte UTF-8 content
    const bigContent = Array.from({ length: 400 }, () => line).join('\n');
    const symbol = makeSymbol({ startLine: 1, endLine: 400, content: bigContent });
    const chunks = chunkSymbol(symbol, CONTEXT);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      // A corrupted split would produce invalid/truncated multi-byte
      // sequences, which the U+FFFD replacement character check below
      // would catch if this string had ever passed through a byte-level
      // (rather than line-level) cut.
      assert.ok(!chunk.content.includes('�'));
    }
  });

  it('TEST 24 — computeContentHash is deterministic for identical content and differs for different content', () => {
    assert.equal(computeContentHash('const x = 1;'), computeContentHash('const x = 1;'));
    assert.notEqual(computeContentHash('const x = 1;'), computeContentHash('const x = 2;'));
  });

  it('TEST 25 — computeChunkKey is deterministic for identical inputs and differs when any input changes', () => {
    const base = { repositoryId: 'r1', commitSha: 'c1', filePath: 'a.ts', symbolType: 'function', symbol: 'foo', startLine: 1, endLine: 5, chunkIndex: 0 };
    assert.equal(computeChunkKey(base), computeChunkKey({ ...base }));
    assert.notEqual(computeChunkKey(base), computeChunkKey({ ...base, commitSha: 'c2' }));
    assert.notEqual(computeChunkKey(base), computeChunkKey({ ...base, filePath: 'b.ts' }));
    assert.notEqual(computeChunkKey(base), computeChunkKey({ ...base, chunkIndex: 1 }));
  });

  it('the same symbol chunked twice (simulating re-indexing the same commit) produces identical chunk keys and hashes', () => {
    const symbol = makeSymbol();
    const first = chunkSymbol(symbol, CONTEXT);
    const second = chunkSymbol(symbol, CONTEXT);
    assert.deepEqual(first, second);
  });

  it('chunk identity changes if the commit sha changes, even for identical content', () => {
    const symbol = makeSymbol();
    const first = chunkSymbol(symbol, CONTEXT);
    const second = chunkSymbol(symbol, { ...CONTEXT, commitSha: 'def456' });
    assert.notEqual(first[0].chunkKey, second[0].chunkKey);
    assert.equal(first[0].contentHash, second[0].contentHash); // same text, so content identity is unchanged
  });
});
