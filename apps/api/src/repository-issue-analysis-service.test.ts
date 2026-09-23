import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  REPOSITORY_ISSUE_MAX_EVIDENCE_CHARS,
  REPOSITORY_ISSUE_MAX_EVIDENCE_CHUNKS,
  IssueAnalysisError,
  boundEvidence,
  gatherDirectEvidence,
  runIssueAnalysis,
  type SearchEvidenceCandidate,
} from './repository-issue-analysis-service.js';
import { IssueAnalysisProviderError, type IssueAnalysisProvider, type IssueAnalysisProviderResult } from './repository-issue-analysis-provider.js';
import type { InsertCodeChunkInput } from './db/repository-index-repository.js';

function makeChunk(overrides: Partial<InsertCodeChunkInput> = {}): InsertCodeChunkInput {
  return {
    id: randomUUID(), indexJobId: 'job-1', repositoryId: 'repo-1', commitSha: 'a'.repeat(40), fileId: randomUUID(),
    filePath: 'src/a.ts', language: 'typescript', symbol: 'foo', symbolType: 'function', parentSymbol: null,
    startLine: 1, endLine: 5, startColumn: 0, endColumn: 1, isExported: true, content: 'function foo() {}',
    contentHash: 'hash', chunkKey: 'key',
    ...overrides,
  };
}

describe('gatherDirectEvidence', () => {
  it('returns nothing when the issue has neither filePath nor symbol', () => {
    const chunks = [makeChunk()];
    assert.deepEqual(gatherDirectEvidence({}, chunks), []);
  });

  it('filters to chunks matching the issue filePath', () => {
    const chunks = [makeChunk({ filePath: 'src/a.ts' }), makeChunk({ filePath: 'src/b.ts' })];
    const result = gatherDirectEvidence({ filePath: 'src/a.ts' }, chunks);
    assert.equal(result.length, 1);
    assert.equal(result[0].filePath, 'src/a.ts');
  });

  it('filters to chunks matching the issue symbol', () => {
    const chunks = [makeChunk({ symbol: 'foo' }), makeChunk({ symbol: 'bar' })];
    const result = gatherDirectEvidence({ symbol: 'foo' }, chunks);
    assert.equal(result.length, 1);
    assert.equal(result[0].symbol, 'foo');
  });

  it('excludes a sensitive file even if it somehow has chunks', () => {
    const chunks = [makeChunk({ filePath: '.env', symbol: 'SECRET' })];
    const result = gatherDirectEvidence({ filePath: '.env' }, chunks);
    assert.deepEqual(result, []);
  });
});

describe('boundEvidence', () => {
  it('deduplicates identical chunks appearing in both direct and search evidence', () => {
    const chunk = { filePath: 'src/a.ts', language: 'typescript', symbol: 'foo', symbolType: 'function', startLine: 1, endLine: 5, content: 'x' };
    const result = boundEvidence([chunk], [chunk]);
    assert.equal(result.length, 1);
  });

  it('never exceeds REPOSITORY_ISSUE_MAX_EVIDENCE_CHUNKS', () => {
    const many = Array.from({ length: REPOSITORY_ISSUE_MAX_EVIDENCE_CHUNKS + 10 }, (_, i) => ({
      filePath: `src/f${i}.ts`, language: 'typescript', symbol: `fn${i}`, symbolType: 'function', startLine: 1, endLine: 2, content: 'x',
    }));
    const result = boundEvidence(many, []);
    assert.ok(result.length <= REPOSITORY_ISSUE_MAX_EVIDENCE_CHUNKS);
  });

  it('never exceeds REPOSITORY_ISSUE_MAX_EVIDENCE_CHARS total content', () => {
    const big = Array.from({ length: 4 }, (_, i) => ({
      filePath: `src/f${i}.ts`, language: 'typescript', symbol: `fn${i}`, symbolType: 'function', startLine: 1, endLine: 2,
      content: 'x'.repeat(Math.floor(REPOSITORY_ISSUE_MAX_EVIDENCE_CHARS / 2)),
    }));
    const result = boundEvidence(big, []);
    const totalChars = result.reduce((sum, c) => sum + c.content.length, 0);
    assert.ok(totalChars <= REPOSITORY_ISSUE_MAX_EVIDENCE_CHARS);
  });

  it('excludes sensitive files defensively even at the bounding stage', () => {
    const result = boundEvidence([{ filePath: '.env', language: 'text', symbol: 'x', symbolType: 'x', startLine: 1, endLine: 1, content: 'SECRET=1' }], []);
    assert.deepEqual(result, []);
  });

  it('prioritizes direct evidence over search evidence when the budget is tight', () => {
    const direct = [{ filePath: 'src/direct.ts', language: 'typescript', symbol: 'direct', symbolType: 'function', startLine: 1, endLine: 2, content: 'd' }];
    const search = [{ filePath: 'src/search.ts', language: 'typescript', symbol: 'search', symbolType: 'function', startLine: 1, endLine: 2, content: 's' }];
    const result = boundEvidence(direct, search);
    assert.equal(result[0].filePath, 'src/direct.ts');
  });
});

const SAMPLE_RESULT: IssueAnalysisProviderResult = {
  model: 'test-model', summary: 'S', rootCause: 'R', confidence: 'HIGH',
  affectedFiles: ['src/a.ts'], affectedSymbols: ['foo'], reasoning: 'because', recommendedFix: 'fix it', validationPlan: 'test it',
};

class FakeProvider implements IssueAnalysisProvider {
  calls: unknown[] = [];
  failWith: IssueAnalysisProviderError | null = null;
  async analyze(request: unknown) {
    this.calls.push(request);
    if (this.failWith) throw this.failWith;
    return SAMPLE_RESULT;
  }
}

describe('runIssueAnalysis', () => {
  it('returns the provider result plus the actual evidence chunk count used', async () => {
    const provider = new FakeProvider();
    const chunks = [makeChunk({ filePath: 'src/a.ts', symbol: 'foo' })];
    const result = await runIssueAnalysis({ title: 'T', description: 'D', filePath: 'src/a.ts', symbol: 'foo' }, 'repo-1', chunks, { provider });
    assert.equal(result.summary, 'S');
    assert.equal(result.evidenceChunkCount, 1);
  });

  it('never sends more than the bounded evidence set, even with many matching chunks', async () => {
    const provider = new FakeProvider();
    const chunks = Array.from({ length: 50 }, (_, i) => makeChunk({ filePath: 'src/a.ts', symbol: 'foo', startLine: i, content: `x${i}` }));
    await runIssueAnalysis({ title: 'T', description: 'D', filePath: 'src/a.ts', symbol: 'foo' }, 'repo-1', chunks, { provider });
    const sentEvidence = (provider.calls[0] as { evidence: unknown[] }).evidence;
    assert.ok(sentEvidence.length <= REPOSITORY_ISSUE_MAX_EVIDENCE_CHUNKS);
  });

  it('uses the optional search-based evidence enhancement when provided', async () => {
    const provider = new FakeProvider();
    const searchResult: SearchEvidenceCandidate = { filePath: 'src/other.ts', language: 'typescript', symbol: 'other', symbolType: 'function', startLine: 1, endLine: 2, content: 'other content' };
    let searchCalled = false;
    const result = await runIssueAnalysis(
      { title: 'T', description: 'D' },
      'repo-1',
      [],
      { provider, searchForEvidence: async () => { searchCalled = true; return [searchResult]; } },
    );
    assert.equal(searchCalled, true);
    assert.equal(result.evidenceChunkCount, 1);
  });

  it('proceeds with direct evidence only when the search enhancement throws', async () => {
    const provider = new FakeProvider();
    const chunks = [makeChunk({ filePath: 'src/a.ts', symbol: 'foo' })];
    const result = await runIssueAnalysis(
      { title: 'T', description: 'D', filePath: 'src/a.ts', symbol: 'foo' },
      'repo-1',
      chunks,
      { provider, searchForEvidence: async () => { throw new Error('embeddings not ready'); } },
    );
    assert.equal(result.evidenceChunkCount, 1);
  });

  it('rethrows a provider failure as IssueAnalysisError with the mapped code', async () => {
    const provider = new FakeProvider();
    provider.failWith = new IssueAnalysisProviderError('down', 'ANALYSIS_PROVIDER_UNAVAILABLE');
    await assert.rejects(
      () => runIssueAnalysis({ title: 'T', description: 'D' }, 'repo-1', [], { provider }),
      (e: unknown) => e instanceof IssueAnalysisError && e.code === 'ANALYSIS_PROVIDER_UNAVAILABLE',
    );
  });
});
