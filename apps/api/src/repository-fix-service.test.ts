import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  FixProposalError,
  parseFileDiff,
  proposeFixForIssue,
  validateFixProposal,
} from './repository-fix-service.js';
import { FixProposalProviderError, type FixProposalProvider, type FixProposalProviderFile, type FixProposalProviderResult } from './repository-fix-provider.js';
import type { IssueAnalysisProviderResult } from './repository-issue-analysis-provider.js';
import type { InsertCodeChunkInput, InsertIndexFileInput } from './db/repository-index-repository.js';

const COMMIT_SHA = 'a'.repeat(40);

function makeFile(overrides: Partial<InsertIndexFileInput> = {}): InsertIndexFileInput {
  return {
    id: randomUUID(), indexJobId: 'job-1', repositoryId: 'repo-1', commitSha: COMMIT_SHA,
    filePath: 'src/a.ts', language: 'typescript', fileSizeBytes: 100, contentHash: 'real-hash', status: 'INDEXED',
    ...overrides,
  };
}

function makeChunk(overrides: Partial<InsertCodeChunkInput> = {}): InsertCodeChunkInput {
  return {
    id: randomUUID(), indexJobId: 'job-1', repositoryId: 'repo-1', commitSha: COMMIT_SHA, fileId: randomUUID(),
    filePath: 'src/a.ts', language: 'typescript', symbol: 'foo', symbolType: 'function', parentSymbol: null,
    startLine: 1, endLine: 3, startColumn: 0, endColumn: 1, isExported: true,
    content: 'function foo() {\n  return 1;\n}', contentHash: 'hash', chunkKey: 'key',
    ...overrides,
  };
}

const VALID_DIFF = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n function foo() {\n-  return 1;\n+  return 2;\n }';

describe('parseFileDiff', () => {
  it('parses a well-formed unified diff', () => {
    const parsed = parseFileDiff(VALID_DIFF);
    assert.ok(parsed);
    assert.equal(parsed!.additions, 1);
    assert.equal(parsed!.deletions, 1);
    assert.deepEqual(parsed!.removedLines, ['  return 1;']);
  });

  it('rejects an empty string', () => {
    assert.equal(parseFileDiff(''), null);
  });

  it('rejects text with no @@ hunk marker', () => {
    assert.equal(parseFileDiff('just some prose, not a diff at all'), null);
  });
});

describe('validateFixProposal', () => {
  const indexedFiles = [makeFile()];
  const indexedChunks = [makeChunk()];

  it('accepts a valid MODIFIED proposal grounded in real indexed content', () => {
    const files: FixProposalProviderFile[] = [{ filePath: 'src/a.ts', changeType: 'MODIFIED', diff: VALID_DIFF }];
    const result = validateFixProposal(files, indexedFiles, indexedChunks);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.files[0].oldContentHash, 'real-hash');
      assert.equal(result.files[0].changeType, 'MODIFIED');
    }
  });

  it('rejects an empty file list', () => {
    const result = validateFixProposal([], indexedFiles, indexedChunks);
    assert.equal(result.ok, false);
  });

  it('rejects more files than REPOSITORY_FIX_MAX_FILES', () => {
    const files: FixProposalProviderFile[] = Array.from({ length: 20 }, (_, i) => ({ filePath: `src/f${i}.ts`, changeType: 'MODIFIED', diff: VALID_DIFF }));
    const result = validateFixProposal(files, indexedFiles, indexedChunks);
    assert.equal(result.ok, false);
  });

  it('rejects a diff exceeding REPOSITORY_FIX_MAX_DIFF_BYTES', () => {
    const hugeDiff = `--- a/src/a.ts\n+++ b/src/a.ts\n@@\n${'-x\n'.repeat(20_000)}`;
    const result = validateFixProposal([{ filePath: 'src/a.ts', changeType: 'MODIFIED', diff: hugeDiff }], indexedFiles, indexedChunks);
    assert.equal(result.ok, false);
  });

  it('rejects an absolute path', () => {
    const result = validateFixProposal([{ filePath: '/etc/passwd', changeType: 'MODIFIED', diff: VALID_DIFF }], indexedFiles, indexedChunks);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /safe relative path/);
  });

  it('rejects a Windows-style absolute path', () => {
    const result = validateFixProposal([{ filePath: 'C:\\Windows\\System32\\config', changeType: 'MODIFIED', diff: VALID_DIFF }], indexedFiles, indexedChunks);
    assert.equal(result.ok, false);
  });

  it('rejects a path containing ../ traversal', () => {
    const result = validateFixProposal([{ filePath: '../../etc/passwd', changeType: 'MODIFIED', diff: VALID_DIFF }], indexedFiles, indexedChunks);
    assert.equal(result.ok, false);
  });

  it('rejects a sensitive file', () => {
    const result = validateFixProposal([{ filePath: '.env', changeType: 'MODIFIED', diff: VALID_DIFF }], indexedFiles, indexedChunks);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /sensitive/);
  });

  it('rejects a syntactically invalid patch', () => {
    const result = validateFixProposal([{ filePath: 'src/a.ts', changeType: 'MODIFIED', diff: 'not a real diff' }], indexedFiles, indexedChunks);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /valid unified diff/);
  });

  it('rejects a MODIFIED change to a file that does not exist in the indexed commit', () => {
    const result = validateFixProposal([{ filePath: 'src/does-not-exist.ts', changeType: 'MODIFIED', diff: VALID_DIFF }], indexedFiles, indexedChunks);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not found in the indexed commit/);
  });

  it('rejects a DELETED change to a file that does not exist', () => {
    const result = validateFixProposal([{ filePath: 'src/does-not-exist.ts', changeType: 'DELETED', diff: VALID_DIFF }], indexedFiles, indexedChunks);
    assert.equal(result.ok, false);
  });

  it('rejects an ADDED change to a file that already exists', () => {
    const result = validateFixProposal([{ filePath: 'src/a.ts', changeType: 'ADDED', diff: VALID_DIFF }], indexedFiles, indexedChunks);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /already exists/);
  });

  it('accepts an ADDED file that genuinely does not exist yet', () => {
    const addDiff = '--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+function bar() {\n+}';
    const result = validateFixProposal([{ filePath: 'src/new.ts', changeType: 'ADDED', diff: addDiff }], indexedFiles, indexedChunks);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.files[0].oldContentHash, undefined);
  });

  it('rejects a diff whose removed line does not match any real indexed content (hallucination guard)', () => {
    const fabricatedDiff = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n function foo() {\n-  this line was never in the real file;\n+  return 2;\n }';
    const result = validateFixProposal([{ filePath: 'src/a.ts', changeType: 'MODIFIED', diff: fabricatedDiff }], indexedFiles, indexedChunks);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /does not match the indexed content/);
  });

  it('skips the grounding check (but still validates everything else) for a file with no indexed chunks', () => {
    const jsonFile = makeFile({ filePath: 'config.json' });
    const anyDiff = '--- a/config.json\n+++ b/config.json\n@@ -1,1 +1,1 @@\n-{"a":1}\n+{"a":2}';
    const result = validateFixProposal([{ filePath: 'config.json', changeType: 'MODIFIED', diff: anyDiff }], [jsonFile], []);
    assert.equal(result.ok, true);
  });

  it('defaults an unspecified changeType to MODIFIED', () => {
    const result = validateFixProposal([{ filePath: 'src/a.ts', diff: VALID_DIFF } as FixProposalProviderFile], indexedFiles, indexedChunks);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.files[0].changeType, 'MODIFIED');
  });
});

const ANALYSIS: IssueAnalysisProviderResult = {
  model: 'm', summary: 'S', rootCause: 'R', confidence: 'HIGH', affectedFiles: [], affectedSymbols: [],
  reasoning: 'x', recommendedFix: 'fix', validationPlan: 'test',
};

class FakeFixProvider implements FixProposalProvider {
  result: FixProposalProviderResult = { model: 'm', summary: 'Fix summary', files: [{ filePath: 'src/a.ts', changeType: 'MODIFIED', diff: VALID_DIFF }] };
  failWith: FixProposalProviderError | null = null;
  async proposeFix(): Promise<FixProposalProviderResult> {
    if (this.failWith) throw this.failWith;
    return this.result;
  }
}

describe('proposeFixForIssue', () => {
  const indexedFiles = [makeFile()];
  const indexedChunks = [makeChunk()];

  it('produces a validated proposal end-to-end', async () => {
    const provider = new FakeFixProvider();
    const result = await proposeFixForIssue(
      { title: 'T', description: 'D', commitSha: COMMIT_SHA },
      'repo-1',
      COMMIT_SHA,
      ANALYSIS,
      indexedFiles,
      indexedChunks,
      { provider },
    );
    assert.equal(result.summary, 'Fix summary');
    assert.equal(result.filesChanged.length, 1);
    assert.ok(result.proposedDiff.includes('src/a.ts'));
  });

  it('rejects with PROPOSAL_INVALID when the repository commit no longer matches the issue commit', async () => {
    const provider = new FakeFixProvider();
    await assert.rejects(
      () => proposeFixForIssue({ title: 'T', description: 'D', commitSha: COMMIT_SHA }, 'repo-1', 'b'.repeat(40), ANALYSIS, indexedFiles, indexedChunks, { provider }),
      (e: unknown) => e instanceof FixProposalError && e.code === 'PROPOSAL_INVALID',
    );
  });

  it('rejects with PROPOSAL_INVALID when the AI-generated diff fails validation', async () => {
    const provider = new FakeFixProvider();
    provider.result = { model: 'm', summary: 'S', files: [{ filePath: '/etc/passwd', changeType: 'MODIFIED', diff: VALID_DIFF }] };
    await assert.rejects(
      () => proposeFixForIssue({ title: 'T', description: 'D', commitSha: COMMIT_SHA }, 'repo-1', COMMIT_SHA, ANALYSIS, indexedFiles, indexedChunks, { provider }),
      (e: unknown) => e instanceof FixProposalError && e.code === 'PROPOSAL_INVALID',
    );
  });

  it('propagates a provider unavailability as PROPOSAL_PROVIDER_UNAVAILABLE', async () => {
    const provider = new FakeFixProvider();
    provider.failWith = new FixProposalProviderError('down', 'PROPOSAL_PROVIDER_UNAVAILABLE');
    await assert.rejects(
      () => proposeFixForIssue({ title: 'T', description: 'D', commitSha: COMMIT_SHA }, 'repo-1', COMMIT_SHA, ANALYSIS, indexedFiles, indexedChunks, { provider }),
      (e: unknown) => e instanceof FixProposalError && e.code === 'PROPOSAL_PROVIDER_UNAVAILABLE',
    );
  });

  it('propagates a provider timeout as PROPOSAL_TIMEOUT', async () => {
    const provider = new FakeFixProvider();
    provider.failWith = new FixProposalProviderError('slow', 'PROPOSAL_TIMEOUT');
    await assert.rejects(
      () => proposeFixForIssue({ title: 'T', description: 'D', commitSha: COMMIT_SHA }, 'repo-1', COMMIT_SHA, ANALYSIS, indexedFiles, indexedChunks, { provider }),
      (e: unknown) => e instanceof FixProposalError && e.code === 'PROPOSAL_TIMEOUT',
    );
  });
});

describe('no filesystem/process-execution surface', () => {
  it('this module never references child_process, exec, or fs write operations', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('./repository-fix-service.ts', import.meta.url), 'utf8');
    assert.ok(!/child_process|execSync|spawn\(|writeFileSync|writeFile\(/.test(source));
  });
});
