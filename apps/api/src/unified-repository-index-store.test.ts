import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-index-store-test-'));
process.env.SCAN_DATA_DIR = DATA_DIR;
process.env.DATABASE_URL = '';
const DATA_FILE = path.join(DATA_DIR, 'repository-index.json');

const { UnifiedRepositoryIndexStore } = await import('./unified-repository-index-store.js');

function sampleChunk(overrides: Partial<{ indexJobId: string; fileId: string; symbol: string }> = {}) {
  return {
    id: randomUUID(),
    indexJobId: overrides.indexJobId ?? 'job-1',
    repositoryId: 'repo-1',
    commitSha: 'abc123',
    fileId: overrides.fileId ?? 'file-1',
    filePath: 'src/index.ts',
    language: 'typescript',
    symbol: overrides.symbol ?? 'add',
    symbolType: 'function',
    parentSymbol: null,
    startLine: 1,
    endLine: 3,
    startColumn: 0,
    endColumn: 1,
    isExported: true,
    content: 'function add() {}',
    contentHash: 'hash1',
    chunkKey: 'key1',
  };
}

describe('UnifiedRepositoryIndexStore', () => {
  let store: InstanceType<typeof UnifiedRepositoryIndexStore>;

  beforeEach(() => {
    if (fs.existsSync(DATA_FILE)) fs.rmSync(DATA_FILE);
    store = new UnifiedRepositoryIndexStore();
  });

  it('persists a newly created job as QUEUED with the indexer version stamped', async () => {
    const job = await store.create({ id: randomUUID(), repositoryId: 'repo-1', cloneJobId: 'clone-1', ownerId: 'owner-a', commitSha: 'abc123' });
    assert.equal(job.status, 'QUEUED');
    assert.equal(job.indexerVersion, '1');
    assert.equal(job.commitSha, 'abc123');

    const fetched = await store.getByIdAsync(job.jobId);
    assert.deepEqual(fetched, job);
  });

  it('markRunning and complete transition the job and set timestamps', async () => {
    const jobId = randomUUID();
    await store.create({ id: jobId, repositoryId: 'repo-1', cloneJobId: 'clone-1', ownerId: 'owner-a', commitSha: 'abc123' });

    await store.markRunning(jobId);
    let job = await store.getByIdAsync(jobId);
    assert.equal(job?.status, 'RUNNING');
    assert.ok(job?.startedAt);

    await store.complete(jobId, { status: 'COMPLETED', filesIndexed: 10, filesSkipped: 2, chunksCreated: 40 });
    job = await store.getByIdAsync(jobId);
    assert.equal(job?.status, 'COMPLETED');
    assert.equal(job?.filesIndexed, 10);
    assert.equal(job?.chunksCreated, 40);
    assert.ok(job?.completedAt);
  });

  it('TEST 35 — getLatestForCommitAsync finds an in-progress job for the same repository+commit (the basis for duplicate prevention)', async () => {
    const repositoryId = 'repo-dup';
    const commitSha = 'commit-x';
    const jobId = randomUUID();
    await store.create({ id: jobId, repositoryId, cloneJobId: 'clone-1', ownerId: 'owner-a', commitSha });
    await store.markRunning(jobId);

    const latest = await store.getLatestForCommitAsync(repositoryId, commitSha);
    assert.equal(latest?.jobId, jobId);
    assert.equal(latest?.status, 'RUNNING');
  });

  it('getLatestForCommitAsync does not match a different commit on the same repository', async () => {
    const repositoryId = 'repo-multi-commit';
    await store.create({ id: randomUUID(), repositoryId, cloneJobId: 'clone-1', ownerId: 'owner-a', commitSha: 'commit-old' });

    const latest = await store.getLatestForCommitAsync(repositoryId, 'commit-new');
    assert.equal(latest, undefined);
  });

  it('getLatestForRepositoryAsync returns the most recently created job, newest first', async () => {
    const repositoryId = 'repo-latest';
    const first = await store.create({ id: randomUUID(), repositoryId, cloneJobId: 'clone-1', ownerId: 'owner-a', commitSha: 'c1' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.create({ id: randomUUID(), repositoryId, cloneJobId: 'clone-2', ownerId: 'owner-a', commitSha: 'c2' });

    const latest = await store.getLatestForRepositoryAsync(repositoryId);
    assert.equal(latest?.jobId, second.jobId);
    assert.notEqual(latest?.jobId, first.jobId);
  });

  it('insertFile and insertChunksBatch persist rows queryable via getSummaryAsync', async () => {
    const indexJobId = randomUUID();
    await store.create({ id: indexJobId, repositoryId: 'repo-1', cloneJobId: 'clone-1', ownerId: 'owner-a', commitSha: 'abc123' });

    const fileId = randomUUID();
    await store.insertFile({ id: fileId, indexJobId, repositoryId: 'repo-1', commitSha: 'abc123', filePath: 'src/a.ts', language: 'typescript', fileSizeBytes: 100, contentHash: 'h1', status: 'INDEXED' });
    await store.insertFile({ id: randomUUID(), indexJobId, repositoryId: 'repo-1', commitSha: 'abc123', filePath: '.env', language: 'unknown', fileSizeBytes: 0, status: 'SKIPPED_SENSITIVE' });

    await store.insertChunksBatch([sampleChunk({ indexJobId, fileId }), sampleChunk({ indexJobId, fileId, symbol: 'sub' })]);

    const summary = await store.getSummaryAsync(indexJobId);
    assert.equal(summary.filesIndexed, 1);
    assert.equal(summary.filesSkipped, 1);
    assert.equal(summary.chunksCreated, 2);
    assert.equal(summary.languages.typescript, 1);
  });

  it('TEST 39 — deletePartialIndex removes a job\'s file/chunk rows so a cancelled job leaves nothing searchable', async () => {
    const indexJobId = randomUUID();
    await store.create({ id: indexJobId, repositoryId: 'repo-1', cloneJobId: 'clone-1', ownerId: 'owner-a', commitSha: 'abc123' });
    const fileId = randomUUID();
    await store.insertFile({ id: fileId, indexJobId, repositoryId: 'repo-1', commitSha: 'abc123', filePath: 'src/a.ts', language: 'typescript', fileSizeBytes: 100, contentHash: 'h1', status: 'INDEXED' });
    await store.insertChunksBatch([sampleChunk({ indexJobId, fileId })]);

    let summary = await store.getSummaryAsync(indexJobId);
    assert.equal(summary.chunksCreated, 1);

    await store.deletePartialIndex(indexJobId);

    summary = await store.getSummaryAsync(indexJobId);
    assert.equal(summary.filesIndexed, 0);
    assert.equal(summary.filesSkipped, 0);
    assert.equal(summary.chunksCreated, 0);
  });

  it('deletePartialIndex for one job never affects another job\'s rows', async () => {
    const jobA = randomUUID();
    const jobB = randomUUID();
    await store.create({ id: jobA, repositoryId: 'repo-1', cloneJobId: 'clone-1', ownerId: 'owner-a', commitSha: 'c1' });
    await store.create({ id: jobB, repositoryId: 'repo-1', cloneJobId: 'clone-2', ownerId: 'owner-a', commitSha: 'c2' });

    const fileA = randomUUID();
    const fileB = randomUUID();
    await store.insertFile({ id: fileA, indexJobId: jobA, repositoryId: 'repo-1', commitSha: 'c1', filePath: 'a.ts', language: 'typescript', fileSizeBytes: 1, status: 'INDEXED' });
    await store.insertFile({ id: fileB, indexJobId: jobB, repositoryId: 'repo-1', commitSha: 'c2', filePath: 'b.ts', language: 'typescript', fileSizeBytes: 1, status: 'INDEXED' });
    await store.insertChunksBatch([sampleChunk({ indexJobId: jobA, fileId: fileA })]);
    await store.insertChunksBatch([sampleChunk({ indexJobId: jobB, fileId: fileB })]);

    await store.deletePartialIndex(jobA);

    assert.equal((await store.getSummaryAsync(jobA)).chunksCreated, 0);
    assert.equal((await store.getSummaryAsync(jobB)).chunksCreated, 1);
  });

  it('returns undefined for an unknown job id', async () => {
    assert.equal(await store.getByIdAsync(randomUUID()), undefined);
  });
});
