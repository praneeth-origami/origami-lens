import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/**
 * Isolated, disposable data dir + no Postgres/Redis — same pattern as the
 * Phase 2/3 worker tests. Embedding needs no real model server or network
 * access at all when a fake EmbeddingProvider is injected (see FakeEmbeddingProvider
 * below), so every test here — including the full integration scenario — is
 * offline and deterministic.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-embedding-worker-test-'));
process.env.SCAN_DATA_DIR = DATA_DIR;
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';

const { UnifiedRepositoryEmbeddingStore } = await import('../unified-repository-embedding-store.js');
const { UnifiedRepositoryStore } = await import('../unified-repository-store.js');
const { UnifiedRepositoryIndexStore } = await import('../unified-repository-index-store.js');
const { UnifiedRepositoryCloneStore } = await import('../unified-repository-clone-store.js');
const { resolveCloneDir } = await import('../repository-clone-service.js');
const { processJob: processIndexJob } = await import('./repository-index-worker.js');
const { processJob, cancelRepositoryEmbeddingJob, enqueueRepositoryEmbeddingJob } = await import('./repository-embedding-worker.js');
const { EmbeddingProviderError } = await import('../repository-embedding-provider.js');

const REAL_ALLOWLISTED_URL = 'https://github.com/octocat/Hello-World';
const FAKE_DIMENSIONS = 8;

/** Deterministic, offline stand-in for BGE-M3 — same text always produces the same vector, distinct texts produce distinct vectors, and it never makes a network call. This is a test-only construct; production code always uses HttpEmbeddingProvider (see repository-embedding-provider.ts). */
class FakeEmbeddingProvider {
  model = 'fake-bge-m3';
  dimensions = FAKE_DIMENSIONS;
  available = true;
  calls: string[][] = [];
  failWith: EmbeddingProviderError | null = null;
  wrongDimensionsOnce = false;

  async isAvailable() {
    return { available: this.available, reachable: true };
  }

  async embedBatch(texts: string[], signal?: AbortSignal) {
    this.calls.push(texts);
    if (signal?.aborted) throw new EmbeddingProviderError('Embedding request cancelled by caller', 'EMBEDDING_CANCELLED');
    if (this.failWith) throw this.failWith;
    const dims = this.wrongDimensionsOnce ? (this.wrongDimensionsOnce = false, FAKE_DIMENSIONS + 1) : this.dimensions;
    return { model: this.model, dimensions: dims, vectors: texts.map((t) => deterministicVector(t, dims)) };
  }
}

function deterministicVector(text: string, dims: number): number[] {
  let seed = 7;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  const vector: number[] = [];
  for (let i = 0; i < dims; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    vector.push((seed % 1000) / 1000);
  }
  return vector;
}

function makeStores() {
  return {
    embeddingStore: new UnifiedRepositoryEmbeddingStore(),
    repositoryStore: new UnifiedRepositoryStore(),
    indexStore: new UnifiedRepositoryIndexStore(),
  };
}

/** Synthesizes a COMPLETED index job with N known chunks, without running real Tree-sitter parsing — fast, for testing worker ORCHESTRATION. See the "integration" describe block below for the real end-to-end pipeline. */
async function setupCompletedIndex(
  indexStore: InstanceType<typeof UnifiedRepositoryIndexStore>,
  repositoryId: string,
  chunkContents: string[],
  commitSha = 'a'.repeat(40),
) {
  const indexJobId = randomUUID();
  await indexStore.create({ id: indexJobId, repositoryId, cloneJobId: randomUUID(), ownerId: 'owner-a', commitSha });
  await indexStore.markRunning(indexJobId);

  const fileId = randomUUID();
  await indexStore.insertFile({ id: fileId, indexJobId, repositoryId, commitSha, filePath: 'src/a.ts', language: 'typescript', fileSizeBytes: 100, contentHash: 'file-hash', status: 'INDEXED' });

  const chunks = chunkContents.map((content, i) => ({
    id: randomUUID(),
    indexJobId,
    repositoryId,
    commitSha,
    fileId,
    filePath: 'src/a.ts',
    language: 'typescript',
    symbol: `fn${i}`,
    symbolType: 'function',
    parentSymbol: null,
    startLine: i * 10 + 1,
    endLine: i * 10 + 5,
    startColumn: 0,
    endColumn: 1,
    isExported: true,
    content,
    contentHash: `hash-${content}`,
    chunkKey: `key-${i}`,
  }));
  await indexStore.insertChunksBatch(chunks);
  await indexStore.complete(indexJobId, { status: 'COMPLETED', filesIndexed: 1, filesSkipped: 0, chunksCreated: chunks.length });

  return { indexJobId, chunks };
}

describe('repository-embedding-worker processJob lifecycle', () => {
  it('TEST 19/27/29/30 — QUEUED -> RUNNING -> COMPLETED, persists real vectors, and moves the repository to EMBEDDINGS_READY', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
    await repositoryStore.updateStatus(repository.id, 'READY_FOR_SEARCH');

    const { indexJobId } = await setupCompletedIndex(indexStore, repository.id, ['function a() {}', 'function b() {}']);

    const jobId = randomUUID();
    await embeddingStore.create({ id: jobId, repositoryId: repository.id, indexJobId, ownerId, commitSha: 'a'.repeat(40), model: 'fake-bge-m3' });

    const provider = new FakeEmbeddingProvider();
    await processJob(embeddingStore, repositoryStore, indexStore, { jobId, repositoryId: repository.id, indexJobId, ownerId }, { provider });

    const job = await embeddingStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'COMPLETED');
    assert.equal(job?.totalChunks, 2);
    assert.equal(job?.embeddedChunks, 2);
    assert.equal(job?.failedChunks, 0);
    assert.equal(job?.dimensions, FAKE_DIMENSIONS);

    const repo = await repositoryStore.getByIdAsync(repository.id);
    assert.equal(repo?.status, 'EMBEDDINGS_READY');

    // Idempotency check (TEST 30): re-running the same job id a second time is a no-op guarded by the terminal-status check.
    await processJob(embeddingStore, repositoryStore, indexStore, { jobId, repositoryId: repository.id, indexJobId, ownerId }, { provider });
    assert.equal(provider.calls.length, 1, 'a terminal job must never be reprocessed');
  });

  it('TEST 20 — a provider failure fails the job clearly, with the real error category, and reverts the repository', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
    await repositoryStore.updateStatus(repository.id, 'READY_FOR_SEARCH');
    const { indexJobId } = await setupCompletedIndex(indexStore, repository.id, ['function a() {}']);

    const jobId = randomUUID();
    await embeddingStore.create({ id: jobId, repositoryId: repository.id, indexJobId, ownerId, commitSha: 'a'.repeat(40), model: 'fake-bge-m3' });

    const provider = new FakeEmbeddingProvider();
    provider.failWith = new EmbeddingProviderError('Model server unreachable', 'EMBEDDING_PROVIDER_UNAVAILABLE');
    await processJob(embeddingStore, repositoryStore, indexStore, { jobId, repositoryId: repository.id, indexJobId, ownerId }, { provider });

    const job = await embeddingStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'FAILED');
    assert.equal(job?.errorCategory, 'EMBEDDING_PROVIDER_UNAVAILABLE');

    const repo = await repositoryStore.getByIdAsync(repository.id);
    assert.equal(repo?.status, 'READY_FOR_SEARCH');

    // No fake/partial vectors were left behind.
    assert.equal(await embeddingStore.countEmbeddingsAsync(repository.id, 'a'.repeat(40), 'fake-bge-m3'), 0);
  });

  it('TEST 21 — a timeout is reported with the EMBEDDING_TIMEOUT category', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
    await repositoryStore.updateStatus(repository.id, 'READY_FOR_SEARCH');
    const { indexJobId } = await setupCompletedIndex(indexStore, repository.id, ['function a() {}']);

    const jobId = randomUUID();
    await embeddingStore.create({ id: jobId, repositoryId: repository.id, indexJobId, ownerId, commitSha: 'a'.repeat(40), model: 'fake-bge-m3' });

    const provider = new FakeEmbeddingProvider();
    provider.failWith = new EmbeddingProviderError('Embedding request timed out after 30000ms', 'EMBEDDING_TIMEOUT');
    await processJob(embeddingStore, repositoryStore, indexStore, { jobId, repositoryId: repository.id, indexJobId, ownerId }, { provider });

    const job = await embeddingStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'FAILED');
    assert.equal(job?.errorCategory, 'EMBEDDING_TIMEOUT');
  });

  it('a dimension mismatch mid-job is rejected, not truncated or padded', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
    await repositoryStore.updateStatus(repository.id, 'READY_FOR_SEARCH');
    // AI_EMBED_BATCH_SIZE is read from the environment once at module import
    // time (like every other envInt-derived constant in this project), so a
    // test can't override it mid-file — instead, use more chunks than the
    // real default batch size (16) so batching still naturally splits into
    // two real provider calls, exercising the "wrong dimensions on the
    // second call" path without needing to change that constant at all.
    const contents = Array.from({ length: 20 }, (_, i) => `function fn${i}() { return ${i}; }`);
    const { indexJobId } = await setupCompletedIndex(indexStore, repository.id, contents);

    const jobId = randomUUID();
    await embeddingStore.create({ id: jobId, repositoryId: repository.id, indexJobId, ownerId, commitSha: 'a'.repeat(40), model: 'fake-bge-m3' });

    const provider = new FakeEmbeddingProvider();
    let callCount = 0;
    const originalEmbedBatch = provider.embedBatch.bind(provider);
    provider.embedBatch = async (texts, signal) => {
      callCount += 1;
      if (callCount === 2) return { model: provider.model, dimensions: FAKE_DIMENSIONS + 1, vectors: texts.map((t) => deterministicVector(t, FAKE_DIMENSIONS + 1)) };
      return originalEmbedBatch(texts, signal);
    };

    await processJob(embeddingStore, repositoryStore, indexStore, { jobId, repositoryId: repository.id, indexJobId, ownerId }, { provider });

    assert.equal(callCount, 2, 'the fixture must actually produce two batches for this test to be meaningful');
    const job = await embeddingStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'FAILED');
    assert.equal(job?.errorCategory, 'EMBEDDING_DIMENSION_MISMATCH');
  });

  it('TEST 25 — missing repository is rejected clearly', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const jobId = randomUUID();
    const bogusRepositoryId = randomUUID();
    await embeddingStore.create({ id: jobId, repositoryId: bogusRepositoryId, indexJobId: randomUUID(), ownerId: 'owner-a', commitSha: 'abc', model: 'fake-bge-m3' });

    await processJob(embeddingStore, repositoryStore, indexStore, { jobId, repositoryId: bogusRepositoryId, indexJobId: randomUUID(), ownerId: 'owner-a' }, { provider: new FakeEmbeddingProvider() });

    const job = await embeddingStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'FAILED');
    assert.match(job?.error ?? '', /repository not found/i);
  });

  it('TEST 26 — a missing/incomplete index job is rejected clearly', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });

    const jobId = randomUUID();
    const bogusIndexJobId = randomUUID();
    await embeddingStore.create({ id: jobId, repositoryId: repository.id, indexJobId: bogusIndexJobId, ownerId, commitSha: 'abc', model: 'fake-bge-m3' });

    await processJob(embeddingStore, repositoryStore, indexStore, { jobId, repositoryId: repository.id, indexJobId: bogusIndexJobId, ownerId }, { provider: new FakeEmbeddingProvider() });

    const job = await embeddingStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'FAILED');
    assert.match(job?.error ?? '', /no successful repository index/i);
  });

  it('an index job with zero chunks completes trivially with zero coverage', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
    await repositoryStore.updateStatus(repository.id, 'READY_FOR_SEARCH');
    const { indexJobId } = await setupCompletedIndex(indexStore, repository.id, []);

    const jobId = randomUUID();
    await embeddingStore.create({ id: jobId, repositoryId: repository.id, indexJobId, ownerId, commitSha: 'a'.repeat(40), model: 'fake-bge-m3' });
    await processJob(embeddingStore, repositoryStore, indexStore, { jobId, repositoryId: repository.id, indexJobId, ownerId }, { provider: new FakeEmbeddingProvider() });

    const job = await embeddingStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'COMPLETED');
    assert.equal(job?.totalChunks, 0);
  });

  it('TEST 28 — an oversized chunk is skipped, not failed, and coverage still completes', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
    await repositoryStore.updateStatus(repository.id, 'READY_FOR_SEARCH');

    // AI_EMBED_MAX_INPUT_TOKENS is read from the environment once at module
    // import time and can't be overridden mid-file (see the dimension-
    // mismatch test above) — instead, exceed the real default budget
    // (2000 tokens, ~4 chars/token) directly with a large chunk.
    const { indexJobId } = await setupCompletedIndex(indexStore, repository.id, ['a'.repeat(50_000), 'function normal() { return 1; }']);

    const jobId = randomUUID();
    await embeddingStore.create({ id: jobId, repositoryId: repository.id, indexJobId, ownerId, commitSha: 'a'.repeat(40), model: 'fake-bge-m3' });
    await processJob(embeddingStore, repositoryStore, indexStore, { jobId, repositoryId: repository.id, indexJobId, ownerId }, { provider: new FakeEmbeddingProvider() });

    const job = await embeddingStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'COMPLETED');
    assert.equal(job?.skippedChunks, 1);
    assert.equal(job?.embeddedChunks, 1);
  });

  it('TEST 23 — duplicate job protection: a QUEUED/RUNNING job for the same repository+commit is found by getLatestForCommitAsync', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
    const { indexJobId } = await setupCompletedIndex(indexStore, repository.id, ['function a() {}']);
    const commitSha = 'a'.repeat(40);

    const jobId = randomUUID();
    await embeddingStore.create({ id: jobId, repositoryId: repository.id, indexJobId, ownerId, commitSha, model: 'fake-bge-m3' });

    const latest = await embeddingStore.getLatestForCommitAsync(repository.id, commitSha);
    assert.equal(latest?.jobId, jobId);
    assert.equal(latest?.status, 'QUEUED');
  });

  it('TEST 30 — re-embedding after a prior successful run reuses existing embeddings by content hash (no redundant provider calls)', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
    await repositoryStore.updateStatus(repository.id, 'READY_FOR_SEARCH');
    const { indexJobId } = await setupCompletedIndex(indexStore, repository.id, ['function a() {}', 'function b() {}']);
    const commitSha = 'a'.repeat(40);

    const firstJobId = randomUUID();
    await embeddingStore.create({ id: firstJobId, repositoryId: repository.id, indexJobId, ownerId, commitSha, model: 'fake-bge-m3' });
    const provider1 = new FakeEmbeddingProvider();
    await processJob(embeddingStore, repositoryStore, indexStore, { jobId: firstJobId, repositoryId: repository.id, indexJobId, ownerId }, { provider: provider1 });
    assert.equal((await embeddingStore.getByIdAsync(firstJobId))?.status, 'COMPLETED');

    // A second embedding job for the exact same index/commit — every chunk's content hash is already covered.
    await repositoryStore.updateStatus(repository.id, 'READY_FOR_SEARCH');
    const secondJobId = randomUUID();
    await embeddingStore.create({ id: secondJobId, repositoryId: repository.id, indexJobId, ownerId, commitSha, model: 'fake-bge-m3' });
    const provider2 = new FakeEmbeddingProvider();
    await processJob(embeddingStore, repositoryStore, indexStore, { jobId: secondJobId, repositoryId: repository.id, indexJobId, ownerId }, { provider: provider2 });

    const secondJob = await embeddingStore.getByIdAsync(secondJobId);
    assert.equal(secondJob?.status, 'COMPLETED');
    assert.equal(secondJob?.embeddedChunks, 2);
    assert.equal(provider2.calls.length, 0, 'a fully-reused re-embedding run must never call the provider');

    // Still exactly 2 rows total, not 4 — no duplicates were created.
    assert.equal(await embeddingStore.countEmbeddingsAsync(repository.id, commitSha, 'fake-bge-m3'), 2);
  });
});

describe('repository-embedding-worker cancellation', () => {
  it('TEST 22/24 — cancelling a RUNNING embedding job stops it, deletes partial rows, marks CANCELLED, and reverts the repository', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
    await repositoryStore.updateStatus(repository.id, 'READY_FOR_SEARCH');

    // All 10 chunks fit in a single real batch (default AI_EMBED_BATCH_SIZE
    // is 16, and it can't be overridden mid-file — see the dimension-
    // mismatch test above) — the artificial delay below inside that one
    // batch call is what gives this test a real window to cancel during.
    const contents = Array.from({ length: 10 }, (_, i) => `function fn${i}() { return ${i}; }`);
    const { indexJobId } = await setupCompletedIndex(indexStore, repository.id, contents);

    const jobId = randomUUID();
    await embeddingStore.create({ id: jobId, repositoryId: repository.id, indexJobId, ownerId, commitSha: 'a'.repeat(40), model: 'fake-bge-m3' });

    const provider = new FakeEmbeddingProvider();
    const originalEmbedBatch = provider.embedBatch.bind(provider);
    provider.embedBatch = async (texts, signal) => {
      await new Promise((r) => setTimeout(r, 15)); // slow enough for the test to cancel mid-run
      return originalEmbedBatch(texts, signal);
    };

    const jobPromise = processJob(embeddingStore, repositoryStore, indexStore, { jobId, repositoryId: repository.id, indexJobId, ownerId }, { provider });

    const pollStart = Date.now();
    let runningJob = await embeddingStore.getByIdAsync(jobId);
    while (runningJob?.status !== 'RUNNING' && Date.now() - pollStart < 2000) {
      await new Promise((r) => setTimeout(r, 5));
      runningJob = await embeddingStore.getByIdAsync(jobId);
    }
    assert.equal(runningJob?.status, 'RUNNING');

    const cancelResult = await cancelRepositoryEmbeddingJob(embeddingStore, repositoryStore, jobId);
    assert.equal(cancelResult?.status, 'CANCELLED');

    await jobPromise;

    const job = await embeddingStore.getByIdAsync(jobId);
    assert.equal(job?.status, 'CANCELLED');
    assert.equal(await embeddingStore.countEmbeddingsAsync(repository.id, 'a'.repeat(40), 'fake-bge-m3'), 0);

    const repo = await repositoryStore.getByIdAsync(repository.id);
    assert.equal(repo?.status, 'READY_FOR_SEARCH');
  });

  it('cancelling an already-terminal job is idempotent', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
    await repositoryStore.updateStatus(repository.id, 'READY_FOR_SEARCH');
    const { indexJobId } = await setupCompletedIndex(indexStore, repository.id, ['function a() {}']);

    const jobId = randomUUID();
    await embeddingStore.create({ id: jobId, repositoryId: repository.id, indexJobId, ownerId, commitSha: 'a'.repeat(40), model: 'fake-bge-m3' });
    await processJob(embeddingStore, repositoryStore, indexStore, { jobId, repositoryId: repository.id, indexJobId, ownerId }, { provider: new FakeEmbeddingProvider() });

    const before = await embeddingStore.getByIdAsync(jobId);
    assert.equal(before?.status, 'COMPLETED');

    const result = await cancelRepositoryEmbeddingJob(embeddingStore, repositoryStore, jobId);
    assert.equal(result?.status, 'COMPLETED');
  });

  it('returns undefined when cancelling a job id that does not exist', async () => {
    const { embeddingStore, repositoryStore } = makeStores();
    const result = await cancelRepositoryEmbeddingJob(embeddingStore, repositoryStore, randomUUID());
    assert.equal(result, undefined);
  });
});

describe('enqueueRepositoryEmbeddingJob', () => {
  it('drives the job via the no-Redis fallback (setImmediate -> processJob)', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
    await repositoryStore.updateStatus(repository.id, 'READY_FOR_SEARCH');
    const { indexJobId } = await setupCompletedIndex(indexStore, repository.id, ['function a() {}']);

    const jobId = randomUUID();
    await embeddingStore.create({ id: jobId, repositoryId: repository.id, indexJobId, ownerId, commitSha: 'a'.repeat(40), model: 'fake-bge-m3' });
    // enqueueRepositoryEmbeddingJob always uses the real HttpEmbeddingProvider
    // (no deps injection through the public enqueue path), so this genuinely
    // depends on whatever is listening at AI_ROUTER_URL in this environment
    // — usually nothing (yielding EMBEDDING_PROVIDER_UNAVAILABLE), but a real
    // AI Router happening to be running locally would let it actually
    // succeed. Either is acceptable: the point of this test is only that the
    // no-Redis fallback path actually drives the job to a terminal state at
    // all, matching the equivalent Phase 2/3 tests.
    enqueueRepositoryEmbeddingJob(embeddingStore, repositoryStore, indexStore, { jobId, repositoryId: repository.id, indexJobId, ownerId });

    const start = Date.now();
    let job = await embeddingStore.getByIdAsync(jobId);
    while (job && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status) && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 20));
      job = await embeddingStore.getByIdAsync(jobId);
    }
    assert.ok(job?.status === 'COMPLETED' || job?.status === 'FAILED');
  });
});

describe('integration — clone fixture -> index -> embed with a fake provider', () => {
  let fixtureRepo: string;

  function runGit(cwd: string, args: string[]) {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  }

  before(() => {
    fixtureRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-embedding-integration-fixture-'));
    runGit(fixtureRepo, ['init', '--quiet']);
    runGit(fixtureRepo, ['config', 'user.email', 'test@example.com']);
    runGit(fixtureRepo, ['config', 'user.name', 'Origami Test']);
    runGit(fixtureRepo, ['checkout', '-b', 'main']);
    fs.mkdirSync(path.join(fixtureRepo, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(fixtureRepo, 'src', 'services'), { recursive: true });
    fs.mkdirSync(path.join(fixtureRepo, 'node_modules', 'some-dep'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRepo, 'src', 'components', 'Header.tsx'), "import React from 'react';\n\nexport function Header(props: { title: string }) {\n  return <h1>{props.title}</h1>;\n}\n");
    fs.writeFileSync(path.join(fixtureRepo, 'src', 'services', 'auth.ts'), 'export class AuthService {\n  login(user: string) {\n    return user;\n  }\n}\n');
    fs.writeFileSync(path.join(fixtureRepo, 'package.json'), '{"name": "fixture"}');
    fs.writeFileSync(path.join(fixtureRepo, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(fixtureRepo, 'node_modules', 'some-dep', 'index.js'), 'module.exports = {};');
    runGit(fixtureRepo, ['add', '.']);
    runGit(fixtureRepo, ['commit', '-m', 'initial']);
  });

  after(() => {
    fs.rmSync(fixtureRepo, { recursive: true, force: true });
  });

  it('embeds every real chunk produced by the real Phase 3 pipeline, with matching dimensions and content hashes, and is idempotent on re-run', async () => {
    const { embeddingStore, repositoryStore, indexStore } = makeStores();
    const cloneStore = new UnifiedRepositoryCloneStore();

    const ownerId = `owner-${randomUUID()}`;
    const repository = await repositoryStore.create({ id: randomUUID(), userId: ownerId, repoUrl: REAL_ALLOWLISTED_URL, provider: 'GITHUB', branch: 'main' });
    const cloneJobId = randomUUID();
    await cloneStore.create({ id: cloneJobId, repositoryId: repository.id, ownerId });

    const cloneDir = resolveCloneDir(repository.id, cloneJobId);
    const { cloneRepository, getCommitSha } = await import('../repository-git.js');
    await cloneRepository(fixtureRepo, 'main', cloneDir, new AbortController().signal);
    const commitSha = await getCommitSha(cloneDir);

    await cloneStore.markRunning(cloneJobId, cloneDir);
    await cloneStore.complete(cloneJobId, {
      status: 'COMPLETED',
      commitSha,
      discovery: { fileCount: 4, directoryCount: 3, totalSizeBytes: 500, topLevelDirectories: ['src'], topLevelFiles: ['package.json'], extensions: {}, largestFiles: [] },
    });
    await repositoryStore.updateStatus(repository.id, 'READY_FOR_INDEXING');

    // Real Phase 3 indexing (Tree-sitter, not mocked).
    const indexJobId = randomUUID();
    await indexStore.create({ id: indexJobId, repositoryId: repository.id, cloneJobId, ownerId, commitSha });
    await processIndexJob(indexStore, repositoryStore, cloneStore, { jobId: indexJobId, repositoryId: repository.id, cloneJobId, ownerId });

    const indexJob = await indexStore.getByIdAsync(indexJobId);
    assert.equal(indexJob?.status, 'COMPLETED');
    assert.ok((indexJob?.chunksCreated ?? 0) > 0, 'the fixture must actually produce chunks');

    const chunksBeforeEmbedding = await indexStore.getChunksForJobAsync(indexJobId);
    assert.ok(chunksBeforeEmbedding.length > 0);
    assert.ok(chunksBeforeEmbedding.some((c) => c.symbol === 'Header'));
    assert.ok(chunksBeforeEmbedding.some((c) => c.symbol === 'AuthService'));

    // Phase 4 embedding, with a fake (offline, deterministic) provider.
    const embedJobId = randomUUID();
    await embeddingStore.create({ id: embedJobId, repositoryId: repository.id, indexJobId, ownerId, commitSha, model: 'fake-bge-m3' });
    const provider = new FakeEmbeddingProvider();
    await processJob(embeddingStore, repositoryStore, indexStore, { jobId: embedJobId, repositoryId: repository.id, indexJobId, ownerId }, { provider });

    const embedJob = await embeddingStore.getByIdAsync(embedJobId);
    assert.equal(embedJob?.status, 'COMPLETED');
    assert.equal(embedJob?.commitSha, commitSha);
    assert.equal(embedJob?.totalChunks, chunksBeforeEmbedding.length);
    assert.equal(embedJob?.embeddedChunks, chunksBeforeEmbedding.length);
    assert.equal(embedJob?.dimensions, FAKE_DIMENSIONS);

    const repo = await repositoryStore.getByIdAsync(repository.id);
    assert.equal(repo?.status, 'EMBEDDINGS_READY');

    const embeddingCount = await embeddingStore.countEmbeddingsAsync(repository.id, commitSha, 'fake-bge-m3');
    // Distinct content hashes only (two chunks with byte-identical content
    // would share one row) — bounded by, never exceeding, the chunk count.
    assert.ok(embeddingCount > 0 && embeddingCount <= chunksBeforeEmbedding.length);

    // Duplicate execution does not duplicate embeddings (re-run the exact same job id).
    await processJob(embeddingStore, repositoryStore, indexStore, { jobId: embedJobId, repositoryId: repository.id, indexJobId, ownerId }, { provider });
    assert.equal(await embeddingStore.countEmbeddingsAsync(repository.id, commitSha, 'fake-bge-m3'), embeddingCount);
  });
});
