import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { approximateTokenCount, buildEmbeddingInput, exceedsMaxEmbeddingInputTokens } from './repository-embedding-service.js';

const SAMPLE_CHUNK = {
  filePath: 'src/components/Header.tsx',
  language: 'tsx',
  symbol: 'Header',
  symbolType: 'function',
  startLine: 12,
  endLine: 84,
  content: 'export function Header(props) {\n  return <div>{props.title}</div>;\n}',
};

describe('buildEmbeddingInput', () => {
  it('produces the documented deterministic format', () => {
    const input = buildEmbeddingInput(SAMPLE_CHUNK);
    assert.ok(input.startsWith('File: src/components/Header.tsx\n'));
    assert.match(input, /Language: tsx/);
    assert.match(input, /Symbol: Header/);
    assert.match(input, /Symbol Type: function/);
    assert.match(input, /Lines: 12-84/);
    assert.match(input, /export function Header/);
  });

  it('is fully deterministic — the same chunk always produces the exact same input', () => {
    assert.equal(buildEmbeddingInput(SAMPLE_CHUNK), buildEmbeddingInput({ ...SAMPLE_CHUNK }));
  });

  it('never includes a timestamp, job id, or other transient metadata', () => {
    const input = buildEmbeddingInput(SAMPLE_CHUNK);
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(input), 'must not contain an ISO timestamp');
    assert.ok(!/jobId|job_id/i.test(input));
  });

  it('scrubs an accidentally-committed secret out of chunk content before it is ever embedded', () => {
    const withSecret = { ...SAMPLE_CHUNK, content: 'const token = "Bearer sk-abcdefghijklmnopqrstuvwxyz123456";' };
    const input = buildEmbeddingInput(withSecret);
    assert.ok(!input.includes('sk-abcdefghijklmnopqrstuvwxyz123456'));
  });

  it('scrubs an email address out of chunk content', () => {
    const withEmail = { ...SAMPLE_CHUNK, content: '// contact: someone@example.com for help' };
    const input = buildEmbeddingInput(withEmail);
    assert.ok(!input.includes('someone@example.com'));
  });

  it('different content produces different input', () => {
    const a = buildEmbeddingInput(SAMPLE_CHUNK);
    const b = buildEmbeddingInput({ ...SAMPLE_CHUNK, content: 'different content entirely' });
    assert.notEqual(a, b);
  });
});

describe('approximateTokenCount / exceedsMaxEmbeddingInputTokens', () => {
  it('estimates roughly 4 characters per token', () => {
    assert.equal(approximateTokenCount('a'.repeat(400)), 100);
  });

  it('a small chunk does not exceed the configured budget', () => {
    const input = buildEmbeddingInput(SAMPLE_CHUNK);
    assert.equal(exceedsMaxEmbeddingInputTokens(input), false);
  });

  it('an extremely large chunk exceeds the configured budget', () => {
    const hugeContent = 'x'.repeat(50_000);
    const input = buildEmbeddingInput({ ...SAMPLE_CHUNK, content: hugeContent });
    assert.equal(exceedsMaxEmbeddingInputTokens(input), true);
  });
});
