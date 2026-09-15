import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-embedding-store-test-'));
process.env.SCAN_DATA_DIR = DATA_DIR;
process.env.DATABASE_URL = '';
const DATA_FILE = path.join(DATA_DIR, 'repository-embeddings.json');

const { UnifiedRepositoryEmbeddingStore } = await import('./unified-repository-embedding-store.js');

function sampleEmbedding(overrides: Partial<{ repositoryId: string; commitSha: string; model: string; contentHash: string; embeddingJobId: string; chunkId: string }> = {}) {
  return {
    id: randomUUID(),
    repositoryId: overrides.repositoryId ?? 'repo-1',
    embeddingJobId: overrides.embeddingJobId ?? 'job-1',
    chunkId: overrides.chunkId ?? randomUUID(),
    commitSha: overrides.commitSha ?? 'commit-abc',
    model: overrides.model ?? 'bge-m3',
    dimensions: 4,
    contentHash: overrides.contentHash ?? 'hash-1',
    vector: [0.1, 0.2, 0.3, 0.4],
  };
}

describe('UnifiedRepositoryEmbeddingStore', () => {
  let store: InstanceType<typeof UnifiedRepositoryEmbeddingStore>;

  beforeEach(() => {
    if (fs.existsSync(DATA_FILE)) fs.rmSync(DATA_FILE);
    store = new UnifiedRepositoryEmbeddingStore();
  });

  it('TEST 9 — persists a newly created job as QUEUED with the configured model', async () => {
    const job = await store.create({ id: randomUUID(), repositoryId: 'repo-1', indexJobId: 'index-1', ownerId: 'owner-a', commitSha: 'abc123', model: 'bge-m3' });
    assert.equal(job.status, 'QUEUED');
    assert.equal(job.model, 'bge-m3');

    const fetched = await store.getByIdAsync(job.jobId);
    assert.deepEqual(fetched, job);
  });

  it('markRunning and complete transition the job with real counts and dimensions', async () => {
    const jobId = randomUUID();
    await store.create({ id: jobId, repositoryId: 'repo-1', indexJobId: 'index-1', ownerId: 'owner-a', commitSha: 'abc123', model: 'bge-m3' });

    await store.markRunning(jobId);
    let job = await store.getByIdAsync(jobId);
    assert.equal(job?.status, 'RUNNING');

    await store.complete(jobId, { status: 'COMPLETED', dimensions: 1024, totalChunks: 10, embeddedChunks: 10, skippedChunks: 0, failedChunks: 0 });
    job = await store.getByIdAsync(jobId);
    assert.equal(job?.status, 'COMPLETED');
    assert.equal(job?.dimensions, 1024);
    assert.equal(job?.embeddedChunks, 10);
  });

  it('TEST 10 — insertEmbeddingsBatch does not create a duplicate for the same (repository, commit, contentHash, model)', async () => {
    const embedding = sampleEmbedding();
    await store.insertEmbeddingsBatch([embedding]);
    await store.insertEmbeddingsBatch([{ ...embedding, id: randomUUID(), chunkId: randomUUID() }]); // same identity, different row id/chunk

    const count = await store.countEmbeddingsAsync(embedding.repositoryId, embedding.commitSha, embedding.model);
    assert.equal(count, 1);
  });

  it('TEST 11 — repository isolation: embeddings for one repository never count toward another', async () => {
    await store.insertEmbeddingsBatch([sampleEmbedding({ repositoryId: 'repo-a', contentHash: 'h1' })]);
    await store.insertEmbeddingsBatch([sampleEmbedding({ repositoryId: 'repo-b', contentHash: 'h1' })]);

    assert.equal(await store.countEmbeddingsAsync('repo-a', 'commit-abc', 'bge-m3'), 1);
    assert.equal(await store.countEmbeddingsAsync('repo-b', 'commit-abc', 'bge-m3'), 1);
  });

  it('TEST 12 — commit isolation: the same content hash under a different commit is a distinct embedding', async () => {
    await store.insertEmbeddingsBatch([sampleEmbedding({ commitSha: 'commit-1', contentHash: 'h1' })]);
    await store.insertEmbeddingsBatch([sampleEmbedding({ commitSha: 'commit-2', contentHash: 'h1' })]);

    assert.equal(await store.countEmbeddingsAsync('repo-1', 'commit-1', 'bge-m3'), 1);
    assert.equal(await store.countEmbeddingsAsync('repo-1', 'commit-2', 'bge-m3'), 1);
  });

  it('TEST 13 — model isolation: the same content under a different model is a distinct embedding', async () => {
    await store.insertEmbeddingsBatch([sampleEmbedding({ model: 'bge-m3', contentHash: 'h1' })]);
    await store.insertEmbeddingsBatch([sampleEmbedding({ model: 'bge-m3-v2', contentHash: 'h1' })]);

    assert.equal(await store.countEmbeddingsAsync('repo-1', 'commit-abc', 'bge-m3'), 1);
    assert.equal(await store.countEmbeddingsAsync('repo-1', 'commit-abc', 'bge-m3-v2'), 1);
  });

  it('TEST 14 — content hash isolation: two different content hashes both get their own embedding', async () => {
    await store.insertEmbeddingsBatch([sampleEmbedding({ contentHash: 'h1' })]);
    await store.insertEmbeddingsBatch([sampleEmbedding({ contentHash: 'h2' })]);

    assert.equal(await store.countEmbeddingsAsync('repo-1', 'commit-abc', 'bge-m3'), 2);
  });

  it('TEST 16 — getLatestForRepositoryAsync returns the most recently created job', async () => {
    const repositoryId = 'repo-latest';
    const first = await store.create({ id: randomUUID(), repositoryId, indexJobId: 'i1', ownerId: 'owner-a', commitSha: 'c1', model: 'bge-m3' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.create({ id: randomUUID(), repositoryId, indexJobId: 'i2', ownerId: 'owner-a', commitSha: 'c2', model: 'bge-m3' });

    const latest = await store.getLatestForRepositoryAsync(repositoryId);
    assert.equal(latest?.jobId, second.jobId);
    assert.notEqual(latest?.jobId, first.jobId);
  });

  it('getLatestForCommitAsync finds an in-progress job for the same repository+commit', async () => {
    const repositoryId = 'repo-dup';
    const commitSha = 'commit-x';
    const jobId = randomUUID();
    await store.create({ id: jobId, repositoryId, indexJobId: 'i1', ownerId: 'owner-a', commitSha, model: 'bge-m3' });
    await store.markRunning(jobId);

    const latest = await store.getLatestForCommitAsync(repositoryId, commitSha);
    assert.equal(latest?.jobId, jobId);
    assert.equal(latest?.status, 'RUNNING');
  });

  it('TEST 17 — a failed job persists its error and error category', async () => {
    const jobId = randomUUID();
    await store.create({ id: jobId, repositoryId: 'repo-1', indexJobId: 'i1', ownerId: 'owner-a', commitSha: 'abc', model: 'bge-m3' });
    await store.complete(jobId, { status: 'FAILED', error: 'The embedding model server is unreachable.', errorCategory: 'EMBEDDING_PROVIDER_UNAVAILABLE' });

    const job = await store.getByIdAsync(jobId);
    assert.equal(job?.status, 'FAILED');
    assert.equal(job?.errorCategory, 'EMBEDDING_PROVIDER_UNAVAILABLE');
  });

  it('TEST 18 — a completed job persists full coverage counts and dimensions', async () => {
    const jobId = randomUUID();
    await store.create({ id: jobId, repositoryId: 'repo-1', indexJobId: 'i1', ownerId: 'owner-a', commitSha: 'abc', model: 'bge-m3' });
    await store.complete(jobId, { status: 'COMPLETED', dimensions: 1024, totalChunks: 500, embeddedChunks: 500, skippedChunks: 0, failedChunks: 0 });

    const job = await store.getByIdAsync(jobId);
    assert.equal(job?.status, 'COMPLETED');
    assert.equal(job?.totalChunks, 500);
    assert.equal(job?.embeddedChunks, 500);
    assert.equal(job?.dimensions, 1024);
  });

  it('deleteEmbeddingsForJob removes only the rows the given job inserted', async () => {
    const jobA = 'job-a';
    const jobB = 'job-b';
    await store.insertEmbeddingsBatch([sampleEmbedding({ embeddingJobId: jobA, contentHash: 'h1' })]);
    await store.insertEmbeddingsBatch([sampleEmbedding({ embeddingJobId: jobB, contentHash: 'h2' })]);

    await store.deleteEmbeddingsForJob(jobA);

    assert.equal(await store.countEmbeddingsAsync('repo-1', 'commit-abc', 'bge-m3'), 1);
  });

  it('findExistingByContentHashesAsync reports which of several content hashes are already covered', async () => {
    await store.insertEmbeddingsBatch([sampleEmbedding({ contentHash: 'h1' }), sampleEmbedding({ contentHash: 'h2' })]);

    const found = await store.findExistingByContentHashesAsync('repo-1', 'commit-abc', 'bge-m3', ['h1', 'h2', 'h3']);
    assert.equal(found.has('h1'), true);
    assert.equal(found.has('h2'), true);
    assert.equal(found.has('h3'), false);
  });

  it('returns undefined for an unknown job id', async () => {
    assert.equal(await store.getByIdAsync(randomUUID()), undefined);
  });
});
