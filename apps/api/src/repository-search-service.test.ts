import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  REPOSITORY_SEARCH_MAX_QUERY_LENGTH,
  REPOSITORY_SEARCH_RESULT_LIMIT,
  SearchError,
  clampResultLimit,
  searchRepository,
  validateSearchQuery,
} from './repository-search-service.js';
import { EmbeddingProviderError, type EmbeddingProvider } from './repository-embedding-provider.js';
import { RerankerProviderError, type RerankerProvider } from './repository-reranker-provider.js';
import { RepositorySearchRepository, type VectorSearchCandidate } from './db/repository-search-repository.js';
import type { UnifiedRepositoryEmbeddingStore } from './unified-repository-embedding-store.js';
import type { UnifiedRepositoryIndexStore } from './unified-repository-index-store.js';
import type { RepositoryEmbeddingJob } from '@origami/contracts';

describe('validateSearchQuery', () => {
  it('TEST 1 — accepts a valid query, trimmed', () => {
    assert.equal(validateSearchQuery('  where is auth handled?  '), 'where is auth handled?');
  });

  it('TEST 2 — rejects an empty query', () => {
    assert.throws(() => validateSearchQuery(''), (e: unknown) => e instanceof SearchError && e.code === 'SEARCH_QUERY_INVALID');
  });

  it('TEST 3 — rejects a whitespace-only query', () => {
    assert.throws(() => validateSearchQuery('   \n\t '), (e: unknown) => e instanceof SearchError && e.code === 'SEARCH_QUERY_INVALID');
  });

  it('TEST 4 — rejects a query exceeding REPOSITORY_SEARCH_MAX_QUERY_LENGTH', () => {
    assert.throws(
      () => validateSearchQuery('a'.repeat(REPOSITORY_SEARCH_MAX_QUERY_LENGTH + 1)),
      (e: unknown) => e instanceof SearchError && e.code === 'SEARCH_QUERY_INVALID',
    );
  });

  it('accepts a query exactly at the max length', () => {
    assert.equal(validateSearchQuery('a'.repeat(REPOSITORY_SEARCH_MAX_QUERY_LENGTH)).length, REPOSITORY_SEARCH_MAX_QUERY_LENGTH);
  });

  it('rejects a non-string query', () => {
    assert.throws(() => validateSearchQuery(42), (e: unknown) => e instanceof SearchError && e.code === 'SEARCH_QUERY_INVALID');
    assert.throws(() => validateSearchQuery(null), (e: unknown) => e instanceof SearchError && e.code === 'SEARCH_QUERY_INVALID');
    assert.throws(() => validateSearchQuery(undefined), (e: unknown) => e instanceof SearchError && e.code === 'SEARCH_QUERY_INVALID');
  });
});

describe('clampResultLimit', () => {
  it('defaults to REPOSITORY_SEARCH_RESULT_LIMIT when omitted', () => {
    assert.equal(clampResultLimit(undefined), REPOSITORY_SEARCH_RESULT_LIMIT);
  });

  it('TEST 30 — never exceeds REPOSITORY_SEARCH_RESULT_LIMIT even when a much larger limit is requested', () => {
    assert.equal(clampResultLimit(10_000), REPOSITORY_SEARCH_RESULT_LIMIT);
  });

  it('honors a smaller requested limit', () => {
    assert.equal(clampResultLimit(3), 3);
  });

  it('falls back to the default for a zero/negative/non-numeric limit', () => {
    assert.equal(clampResultLimit(0), REPOSITORY_SEARCH_RESULT_LIMIT);
    assert.equal(clampResultLimit(-5), REPOSITORY_SEARCH_RESULT_LIMIT);
    assert.equal(clampResultLimit('not-a-number'), REPOSITORY_SEARCH_RESULT_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// searchRepository orchestration — deterministic fake providers, no network.
// ---------------------------------------------------------------------------

const DIMENSIONS = 4;

class FakeEmbeddingProvider implements EmbeddingProvider {
  model = 'fake-bge-m3';
  vector = [0.1, 0.2, 0.3, 0.4];
  dimensions = DIMENSIONS;
  failWith: EmbeddingProviderError | null = null;
  calls = 0;

  async embedBatch(texts: string[], signal?: AbortSignal) {
    this.calls += 1;
    if (signal?.aborted) throw new EmbeddingProviderError('cancelled', 'EMBEDDING_CANCELLED');
    if (this.failWith) throw this.failWith;
    return { model: this.model, dimensions: this.dimensions, vectors: texts.map(() => this.vector) };
  }
}

class FakeRerankerProvider implements RerankerProvider {
  model = 'fake-reranker';
  failWith: RerankerProviderError | null = null;
  calls = 0;
  /** Assigns each document a score equal to its input index, so after sorting descending by score the LAST input document ranks first — visibly reversing the vector-distance-ascending input order, proving reranking (not just vector order) determined the result. */
  async rerank(_query: string, documents: string[], signal?: AbortSignal) {
    this.calls += 1;
    if (signal?.aborted) throw new RerankerProviderError('cancelled', 'SEARCH_FAILED');
    if (this.failWith) throw this.failWith;
    return { model: this.model, scores: documents.map((_, i) => i) };
  }
}

function makeCandidate(overrides: Partial<VectorSearchCandidate> = {}): VectorSearchCandidate {
  return {
    chunkId: overrides.chunkId ?? randomUUID(),
    filePath: overrides.filePath ?? 'src/a.ts',
    language: 'typescript',
    symbol: overrides.symbol ?? 'a',
    symbolType: 'function',
    parentSymbol: null,
    startLine: 1,
    endLine: 3,
    isExported: true,
    content: overrides.content ?? 'function a() {}',
    vectorDistance: overrides.vectorDistance ?? 0.1,
    ...overrides,
  };
}

function fakeStores(overrides: {
  /** `null` explicitly means "no embedding job exists" (distinct from omitting the key, which means "use the default completed job") — a plain `undefined` default value can't be distinguished from an absent key via `??`. */
  embeddingJob?: RepositoryEmbeddingJob | null;
  candidates?: VectorSearchCandidate[];
} = {}) {
  const embeddingJob: RepositoryEmbeddingJob | undefined = overrides.embeddingJob === null ? undefined : overrides.embeddingJob ?? {
    jobId: randomUUID(),
    repositoryId: 'repo-1',
    indexJobId: randomUUID(),
    commitSha: 'a'.repeat(40),
    status: 'COMPLETED',
    model: 'fake-bge-m3',
    dimensions: DIMENSIONS,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const candidates = overrides.candidates ?? [makeCandidate()];

  // A stub that reports isEnabled()=true (so searchRepository() takes the
  // "real pgvector" branch rather than the no-Postgres legacy fallback) and
  // returns a fixed candidate list — the DB repository's own real SQL is
  // tested separately in db/repository-search-repository.test.ts against
  // a live Postgres instance.
  const stubSearchRepo = Object.assign(Object.create(RepositorySearchRepository.prototype), {
    isEnabled: () => true,
    searchByVector: async () => candidates,
  }) as RepositorySearchRepository;

  const embeddingStore = {
    getLatestForRepositoryAsync: async () => embeddingJob,
    getEmbeddingsForCommitLegacy: () => [],
  } as unknown as UnifiedRepositoryEmbeddingStore;

  const indexStore = {
    getChunksForJobAsync: async () => [],
  } as unknown as UnifiedRepositoryIndexStore;

  return { embeddingStore, indexStore, searchRepository: stubSearchRepo };
}

describe('searchRepository', () => {
  it('a valid search returns reranked results ordered by reranker score, not vector distance', async () => {
    const candidates = [
      makeCandidate({ symbol: 'nearest', vectorDistance: 0.05 }),
      makeCandidate({ symbol: 'furthest', vectorDistance: 0.5 }),
    ];
    const stores = fakeStores({ candidates });
    const embedding = new FakeEmbeddingProvider();
    const reranker = new FakeRerankerProvider(); // reverses order: last input scores highest
    const response = await searchRepository(
      { id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' },
      stores,
      { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'test query' },
      { embeddingProvider: embedding, rerankerProvider: reranker },
    );
    assert.equal(response.reranked, true);
    assert.equal(response.results[0].symbol, 'furthest'); // reranker put it first despite larger vector distance
    assert.equal(response.results.length, 2);
    assert.equal(response.commitSha, 'a'.repeat(40));
  });

  it('TEST 5 — embedding provider unavailable surfaces EMBEDDING_PROVIDER_UNAVAILABLE', async () => {
    const stores = fakeStores();
    const embedding = new FakeEmbeddingProvider();
    embedding.failWith = new EmbeddingProviderError('unreachable', 'EMBEDDING_PROVIDER_UNAVAILABLE');
    await assert.rejects(
      () => searchRepository({ id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' }, { embeddingProvider: embedding, rerankerProvider: new FakeRerankerProvider() }),
      (e: unknown) => e instanceof SearchError && e.code === 'EMBEDDING_PROVIDER_UNAVAILABLE',
    );
  });

  it('TEST 6 — embedding timeout surfaces EMBEDDING_TIMEOUT', async () => {
    const stores = fakeStores();
    const embedding = new FakeEmbeddingProvider();
    embedding.failWith = new EmbeddingProviderError('timed out', 'EMBEDDING_TIMEOUT');
    await assert.rejects(
      () => searchRepository({ id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' }, { embeddingProvider: embedding, rerankerProvider: new FakeRerankerProvider() }),
      (e: unknown) => e instanceof SearchError && e.code === 'EMBEDDING_TIMEOUT',
    );
  });

  it('TEST 7 — a query embedding dimension mismatch is rejected, never truncated or padded', async () => {
    const stores = fakeStores();
    const embedding = new FakeEmbeddingProvider();
    embedding.dimensions = DIMENSIONS + 1;
    embedding.vector = [0.1, 0.2, 0.3, 0.4, 0.5];
    await assert.rejects(
      () => searchRepository({ id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' }, { embeddingProvider: embedding, rerankerProvider: new FakeRerankerProvider() }),
      (e: unknown) => e instanceof SearchError && e.code === 'VECTOR_SEARCH_FAILED',
    );
  });

  it('TEST 8 — an already-cancelled signal propagates as a search failure, not a silent success', async () => {
    const stores = fakeStores();
    const embedding = new FakeEmbeddingProvider();
    embedding.failWith = new EmbeddingProviderError('cancelled', 'EMBEDDING_CANCELLED');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => searchRepository({ id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' }, { embeddingProvider: embedding, rerankerProvider: new FakeRerankerProvider() }, controller.signal),
      (e: unknown) => e instanceof SearchError,
    );
  });

  it('missing repository surfaces REPOSITORY_NOT_FOUND', async () => {
    const stores = fakeStores();
    await assert.rejects(
      () => searchRepository(undefined, stores, { repositoryId: 'nope', query: 'q' }, { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: new FakeRerankerProvider() }),
      (e: unknown) => e instanceof SearchError && e.code === 'REPOSITORY_NOT_FOUND',
    );
  });

  it('wrong owner surfaces REPOSITORY_ACCESS_DENIED', async () => {
    const stores = fakeStores();
    await assert.rejects(
      () => searchRepository({ id: 'repo-1', ownerId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-b', query: 'q' }, { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: new FakeRerankerProvider() }),
      (e: unknown) => e instanceof SearchError && e.code === 'REPOSITORY_ACCESS_DENIED',
    );
  });

  it('a repository that was never indexed surfaces REPOSITORY_NOT_READY', async () => {
    const stores = fakeStores();
    await assert.rejects(
      () => searchRepository({ id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'CONNECTED' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' }, { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: new FakeRerankerProvider() }),
      (e: unknown) => e instanceof SearchError && e.code === 'REPOSITORY_NOT_READY',
    );
  });

  it('an indexed repository with no completed embedding job surfaces EMBEDDINGS_NOT_READY', async () => {
    const stores = fakeStores({ embeddingJob: null });
    await assert.rejects(
      () => searchRepository({ id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'READY_FOR_SEARCH' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' }, { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: new FakeRerankerProvider() }),
      (e: unknown) => e instanceof SearchError && e.code === 'EMBEDDINGS_NOT_READY',
    );
  });

  it('an in-progress (non-COMPLETED) embedding job also surfaces EMBEDDINGS_NOT_READY', async () => {
    const runningJob: RepositoryEmbeddingJob = {
      jobId: randomUUID(), repositoryId: 'repo-1', indexJobId: randomUUID(), commitSha: 'a'.repeat(40),
      status: 'RUNNING', model: 'fake-bge-m3', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const stores = fakeStores({ embeddingJob: runningJob });
    await assert.rejects(
      () => searchRepository({ id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDING' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' }, { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: new FakeRerankerProvider() }),
      (e: unknown) => e instanceof SearchError && e.code === 'EMBEDDINGS_NOT_READY',
    );
  });

  it('empty candidates returns a clean success response with results: [] and reranked: false', async () => {
    const stores = fakeStores({ candidates: [] });
    const response = await searchRepository(
      { id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' },
      { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: new FakeRerankerProvider() },
    );
    assert.deepEqual(response.results, []);
    assert.equal(response.reranked, false);
    assert.equal(response.candidateCount, 0);
  });

  it('TEST 31 — no vector arrays appear anywhere in the response', async () => {
    const stores = fakeStores();
    const response = await searchRepository(
      { id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' },
      { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: new FakeRerankerProvider() },
    );
    const serialized = JSON.stringify(response);
    assert.ok(!serialized.includes('0.1,0.2,0.3,0.4'), 'the query vector must never leak into the response');
    for (const result of response.results) {
      assert.ok(!('vector' in result));
      assert.ok(!('embedding' in result));
    }
  });

  it('TEST 32 — a sensitive-file chunk is filtered out even if it somehow reached the candidate list', async () => {
    const candidates = [
      makeCandidate({ filePath: '.env', symbol: 'SECRET' }),
      makeCandidate({ filePath: 'src/normal.ts', symbol: 'normal' }),
    ];
    const stores = fakeStores({ candidates });
    const response = await searchRepository(
      { id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' },
      { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: new FakeRerankerProvider() },
    );
    assert.ok(!response.results.some((r) => r.filePath === '.env'));
    assert.ok(response.results.some((r) => r.filePath === 'src/normal.ts'));
  });

  it('TEST 20 — reranker unavailable degrades gracefully to vector-only ordering with reranked: false', async () => {
    const candidates = [makeCandidate({ symbol: 'a', vectorDistance: 0.1 }), makeCandidate({ symbol: 'b', vectorDistance: 0.2 })];
    const stores = fakeStores({ candidates });
    const reranker = new FakeRerankerProvider();
    reranker.failWith = new RerankerProviderError('unavailable', 'RERANKER_UNAVAILABLE');
    const response = await searchRepository(
      { id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' },
      { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: reranker },
    );
    assert.equal(response.reranked, false);
    assert.equal(response.results[0].symbol, 'a'); // preserved vector-distance-ascending order
    assert.equal(response.results.every((r) => r.rerankerScore === undefined), true);
  });

  it('TEST 21 — reranker timeout also degrades gracefully rather than failing the whole search', async () => {
    const stores = fakeStores();
    const reranker = new FakeRerankerProvider();
    reranker.failWith = new RerankerProviderError('timed out', 'RERANKER_TIMEOUT');
    const response = await searchRepository(
      { id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' },
      { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: reranker },
    );
    assert.equal(response.reranked, false);
  });

  it('TEST 19 — the reranker never receives more than AI_RERANKER_MAX_CANDIDATES documents', async () => {
    const candidates = Array.from({ length: 60 }, (_, i) => makeCandidate({ symbol: `fn${i}`, vectorDistance: i / 100 }));
    const stores = fakeStores({ candidates });
    const reranker = new FakeRerankerProvider();
    await searchRepository(
      { id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' },
      { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: reranker },
    );
    assert.ok(reranker.calls === 1);
  });

  it('respects a smaller caller-requested limit', async () => {
    const candidates = [makeCandidate({ symbol: 'a' }), makeCandidate({ symbol: 'b' }), makeCandidate({ symbol: 'c' })];
    const stores = fakeStores({ candidates });
    const response = await searchRepository(
      { id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q', limit: 1 },
      { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: new FakeRerankerProvider() },
    );
    assert.equal(response.results.length, 1);
  });

  it('content is truncated to the configured maximum', async () => {
    const candidates = [makeCandidate({ content: 'x'.repeat(5000) })];
    const stores = fakeStores({ candidates });
    const response = await searchRepository(
      { id: 'repo-1', userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', query: 'q' },
      { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: new FakeRerankerProvider() },
    );
    assert.ok((response.results[0].content?.length ?? 0) < 5000);
  });
});
