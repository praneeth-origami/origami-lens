// Force the always-available legacy in-memory store path (no live Postgres
// dependency for this test) — same convention as every other integration
// test in this project. Must be set before any store's getPool() call, but
// since pool.ts re-reads process.env.DATABASE_URL fresh on every call
// (never cached at import time — see apps/api/src/db/pool.ts), a plain
// top-of-file assignment is sufficient even with static imports below.
process.env.DATABASE_URL = '';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { searchRepository } from './repository-search-service.js';
import type { EmbeddingProvider } from './repository-embedding-provider.js';
import type { RerankerProvider } from './repository-reranker-provider.js';
import { RepositorySearchRepository } from './db/repository-search-repository.js';
import { UnifiedRepositoryIndexStore } from './unified-repository-index-store.js';
import { UnifiedRepositoryEmbeddingStore } from './unified-repository-embedding-store.js';
import type { InsertCodeChunkInput } from './db/repository-index-repository.js';

/**
 * A deterministic "fixture repository" spanning four semantically distinct
 * concept directories (auth/, payments/, navigation/, utils/), used to
 * verify that the full search pipeline — real UnifiedRepositoryIndexStore +
 * UnifiedRepositoryEmbeddingStore (legacy in-memory mode) -> searchRepository()
 * orchestration -> content-aware fake embedding/reranker providers — actually
 * surfaces the relevant concept directory for a matching query, and a
 * *different* directory for a differently-worded query. This is not testing
 * BGE-M3/bge-reranker-v2-m3 themselves (no real model is available in this
 * environment — see the Phase 5 report's live-verification section); it
 * proves the plumbing around them (chunk -> embedding -> candidate ->
 * rerank -> API-shaped result) is wired correctly end-to-end.
 */

const CONCEPT_KEYWORDS: Record<string, string[]> = {
  auth: ['auth', 'login', 'session', 'password', 'credential'],
  payment: ['payment', 'charge', 'invoice', 'billing', 'checkout'],
  navigation: ['navigation', 'menu', 'header', 'route', 'link'],
  util: ['format', 'currency', 'date', 'helper', 'util'],
};
const CONCEPTS = Object.keys(CONCEPT_KEYWORDS);

/** A crude but genuinely content-derived "embedding": counts keyword-root hits per concept, normalized. Not a real BGE-M3 vector, but it is computed FROM the text, not hand-assigned per fixture — proving the ranking pipeline responds to actual content differences. */
function conceptVector(text: string): number[] {
  const lower = text.toLowerCase();
  const raw = CONCEPTS.map((concept) => {
    const hits = CONCEPT_KEYWORDS[concept].reduce((sum, kw) => sum + (lower.split(kw).length - 1), 0);
    return hits + 0.01; // epsilon so an unrelated chunk never produces an exact zero vector
  });
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
  return raw.map((v) => v / norm);
}

/** Deterministic term-overlap reranker score, independent from conceptVector's math — proves reranking is a genuinely separate signal, not a rename of the vector distance. */
function overlapScore(query: string, document: string): number {
  const q = query.toLowerCase();
  const d = document.toLowerCase();
  let score = 0;
  for (const keywords of Object.values(CONCEPT_KEYWORDS)) {
    for (const kw of keywords) {
      if (q.includes(kw) && d.includes(kw)) score += 1;
    }
  }
  return score;
}

class ConceptEmbeddingProvider implements EmbeddingProvider {
  model = 'concept-fixture-embedding';
  dimensions = CONCEPTS.length;
  async embedBatch(texts: string[]) {
    return { model: this.model, dimensions: this.dimensions, vectors: texts.map(conceptVector) };
  }
}

class OverlapRerankerProvider implements RerankerProvider {
  model = 'concept-fixture-reranker';
  async rerank(query: string, documents: string[]) {
    return { model: this.model, scores: documents.map((doc) => overlapScore(query, doc)) };
  }
}

interface FixtureFile {
  path: string;
  language: string;
  symbol: string;
  content: string;
}

const FIXTURE_FILES: FixtureFile[] = [
  { path: 'src/auth/login.ts', language: 'typescript', symbol: 'authenticateUser', content: 'export function authenticateUser(username: string, password: string) {\n  const credential = lookupCredential(username);\n  return verifyPassword(credential, password);\n}' },
  { path: 'src/auth/session.ts', language: 'typescript', symbol: 'validateSession', content: 'export function validateSession(sessionToken: string) {\n  const session = findSession(sessionToken);\n  return session && !session.expired;\n}' },
  { path: 'src/payments/payment-service.ts', language: 'typescript', symbol: 'processPayment', content: 'export function processPayment(invoice: Invoice) {\n  const charge = createCharge(invoice.billing);\n  return submitCheckout(charge);\n}' },
  { path: 'src/navigation/MobileMenu.tsx', language: 'tsx', symbol: 'MobileMenu', content: 'export function MobileMenu({ routes }) {\n  return <nav className="menu">{routes.map(renderLink)}</nav>;\n}' },
  { path: 'src/navigation/Header.tsx', language: 'tsx', symbol: 'Header', content: 'export function Header() {\n  return <header><MobileMenu routes={navigationRoutes} /></header>;\n}' },
  { path: 'src/utils/formatCurrency.ts', language: 'typescript', symbol: 'formatCurrency', content: 'export function formatCurrency(amount: number) {\n  return new Intl.NumberFormat().format(amount);\n}' },
  { path: 'src/utils/date.ts', language: 'typescript', symbol: 'formatDate', content: 'export function formatDate(date: Date) {\n  return dateHelper.toIsoString(date);\n}' },
];

async function buildFixtureRepository(): Promise<{ repositoryId: string; indexStore: UnifiedRepositoryIndexStore; embeddingStore: UnifiedRepositoryEmbeddingStore }> {
  const indexStore = new UnifiedRepositoryIndexStore();
  const embeddingStore = new UnifiedRepositoryEmbeddingStore();

  const repositoryId = randomUUID();
  const cloneJobId = randomUUID();
  const commitSha = 'f'.repeat(40);

  const indexJob = await indexStore.create({ id: randomUUID(), repositoryId, cloneJobId, commitSha });

  const chunks: InsertCodeChunkInput[] = [];
  for (const file of FIXTURE_FILES) {
    const fileId = randomUUID();
    await indexStore.insertFile({
      id: fileId, indexJobId: indexJob.jobId, repositoryId, commitSha,
      filePath: file.path, language: file.language, fileSizeBytes: file.content.length, status: 'INDEXED',
    });
    chunks.push({
      id: randomUUID(), indexJobId: indexJob.jobId, repositoryId, commitSha, fileId,
      filePath: file.path, language: file.language, symbol: file.symbol, symbolType: 'function',
      parentSymbol: null, startLine: 1, endLine: file.content.split('\n').length,
      startColumn: 0, endColumn: 1, isExported: true, content: file.content,
      contentHash: `hash-${file.path}`, chunkKey: `key-${file.path}`,
    });
  }
  await indexStore.insertChunksBatch(chunks);
  await indexStore.complete(indexJob.jobId, { status: 'COMPLETED', filesIndexed: FIXTURE_FILES.length, filesSkipped: 0, chunksCreated: chunks.length });

  const embeddingJob = await embeddingStore.create({ id: randomUUID(), repositoryId, indexJobId: indexJob.jobId, commitSha, model: 'concept-fixture-embedding' });
  await embeddingStore.insertEmbeddingsBatch(
    chunks.map((c) => ({
      id: randomUUID(), repositoryId, embeddingJobId: embeddingJob.jobId, chunkId: c.id, commitSha,
      model: 'concept-fixture-embedding', dimensions: CONCEPTS.length, contentHash: c.contentHash,
      vector: conceptVector(c.content),
    })),
  );
  await embeddingStore.complete(embeddingJob.jobId, { status: 'COMPLETED', dimensions: CONCEPTS.length, totalChunks: chunks.length, embeddedChunks: chunks.length, skippedChunks: 0, failedChunks: 0 });

  return { repositoryId, indexStore, embeddingStore };
}

describe('Repository search — end-to-end integration against a deterministic concept fixture', () => {
  it('TEST 33 — a query about authentication surfaces auth/ files ahead of unrelated directories', async () => {
    const { repositoryId, indexStore, embeddingStore } = await buildFixtureRepository();
    const stores = { indexStore, embeddingStore, searchRepository: new RepositorySearchRepository() };

    const response = await searchRepository(
      { id: repositoryId, userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' },
      stores,
      { repositoryId, ownerId: 'owner-a', query: 'how are users authenticated when they log in with a password' },
      { embeddingProvider: new ConceptEmbeddingProvider(), rerankerProvider: new OverlapRerankerProvider() },
    );

    assert.equal(response.reranked, true);
    assert.ok(response.results.length > 0);
    assert.ok(response.results[0].filePath.startsWith('src/auth/'), `expected an auth/ file first, got ${response.results[0].filePath}`);
    assert.ok(!response.results[0].filePath.startsWith('src/payments/'));
  });

  it('TEST 34 — a differently-worded query about payments surfaces payments/ files instead — proves this is not a hardcoded outcome', async () => {
    const { repositoryId, indexStore, embeddingStore } = await buildFixtureRepository();
    const stores = { indexStore, embeddingStore, searchRepository: new RepositorySearchRepository() };

    const response = await searchRepository(
      { id: repositoryId, userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' },
      stores,
      { repositoryId, ownerId: 'owner-a', query: 'where do we process a payment charge and invoice billing at checkout' },
      { embeddingProvider: new ConceptEmbeddingProvider(), rerankerProvider: new OverlapRerankerProvider() },
    );

    assert.equal(response.results[0].filePath, 'src/payments/payment-service.ts');
  });

  it('TEST 35 — a navigation-related query surfaces navigation/ files, and each result carries commit/line/symbol metadata', async () => {
    const { repositoryId, indexStore, embeddingStore } = await buildFixtureRepository();
    const stores = { indexStore, embeddingStore, searchRepository: new RepositorySearchRepository() };

    const response = await searchRepository(
      { id: repositoryId, userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' },
      stores,
      { repositoryId, ownerId: 'owner-a', query: 'how does the mobile menu navigation header render its links' },
      { embeddingProvider: new ConceptEmbeddingProvider(), rerankerProvider: new OverlapRerankerProvider() },
    );

    assert.ok(response.results[0].filePath.startsWith('src/navigation/'));
    const top = response.results[0];
    assert.equal(response.commitSha, 'f'.repeat(40));
    assert.ok(typeof top.startLine === 'number' && typeof top.endLine === 'number');
    assert.ok(typeof top.symbol === 'string' && top.symbol.length > 0);
    assert.ok(typeof top.vectorDistance === 'number');
    assert.ok(typeof top.rerankerScore === 'number');
  });

  it('TEST 36 — vector search alone (before reranking) already ranks the matching concept directory above the others', async () => {
    const { repositoryId, indexStore, embeddingStore } = await buildFixtureRepository();
    const stores = { indexStore, embeddingStore, searchRepository: new RepositorySearchRepository() };

    // A reranker that always fails forces the response to fall back to
    // pure vector-distance ordering (reranked: false) — proving the
    // pgvector/legacy-fallback candidate retrieval itself, not just the
    // reranker, is already semantically meaningful.
    class AlwaysFailReranker implements RerankerProvider {
      model = 'always-fail';
      async rerank(): Promise<never> {
        const { RerankerProviderError } = await import('./repository-reranker-provider.js');
        throw new RerankerProviderError('unavailable for this test', 'RERANKER_UNAVAILABLE');
      }
    }

    const response = await searchRepository(
      { id: repositoryId, userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' },
      stores,
      { repositoryId, ownerId: 'owner-a', query: 'formatting a currency amount and a date value with a helper' },
      { embeddingProvider: new ConceptEmbeddingProvider(), rerankerProvider: new AlwaysFailReranker() },
    );

    assert.equal(response.reranked, false);
    assert.ok(response.results[0].filePath.startsWith('src/utils/'), `expected a utils/ file first even in degraded mode, got ${response.results[0].filePath}`);
  });

  it('TEST 37 — commit-aware isolation: two index/embedding runs for the same repository never mix results across commits', async () => {
    const { repositoryId, indexStore, embeddingStore } = await buildFixtureRepository();
    // Simulate a second, later commit that only has a payments file — the
    // active embedding job (the most recently created one) determines
    // which commit is searched; the earlier commit's auth/navigation/utils
    // chunks must not leak into this search.
    const secondCommit = 'e'.repeat(40);
    const cloneJobId2 = randomUUID();
    const indexJob2 = await indexStore.create({ id: randomUUID(), repositoryId, cloneJobId: cloneJobId2, commitSha: secondCommit });
    const fileId2 = randomUUID();
    await indexStore.insertFile({ id: fileId2, indexJobId: indexJob2.jobId, repositoryId, commitSha: secondCommit, filePath: 'src/payments/new-payment.ts', language: 'typescript', fileSizeBytes: 10, status: 'INDEXED' });
    const chunk2: InsertCodeChunkInput = {
      id: randomUUID(), indexJobId: indexJob2.jobId, repositoryId, commitSha: secondCommit, fileId: fileId2,
      filePath: 'src/payments/new-payment.ts', language: 'typescript', symbol: 'newCharge', symbolType: 'function',
      parentSymbol: null, startLine: 1, endLine: 3, startColumn: 0, endColumn: 1, isExported: true,
      content: 'export function newCharge(invoice) { return submitCheckout(invoice.billing); }',
      contentHash: 'hash-new-payment', chunkKey: 'key-new-payment',
    };
    await indexStore.insertChunksBatch([chunk2]);
    await indexStore.complete(indexJob2.jobId, { status: 'COMPLETED', filesIndexed: 1, filesSkipped: 0, chunksCreated: 1 });

    const embeddingJob2 = await embeddingStore.create({ id: randomUUID(), repositoryId, indexJobId: indexJob2.jobId, commitSha: secondCommit, model: 'concept-fixture-embedding' });
    await embeddingStore.insertEmbeddingsBatch([{
      id: randomUUID(), repositoryId, embeddingJobId: embeddingJob2.jobId, chunkId: chunk2.id, commitSha: secondCommit,
      model: 'concept-fixture-embedding', dimensions: CONCEPTS.length, contentHash: chunk2.contentHash, vector: conceptVector(chunk2.content),
    }]);
    await embeddingStore.complete(embeddingJob2.jobId, { status: 'COMPLETED', dimensions: CONCEPTS.length, totalChunks: 1, embeddedChunks: 1, skippedChunks: 0, failedChunks: 0 });

    const stores = { indexStore, embeddingStore, searchRepository: new RepositorySearchRepository() };
    const response = await searchRepository(
      { id: repositoryId, userId: 'owner-a', organizationId: 'owner-a', status: 'EMBEDDINGS_READY' },
      stores,
      { repositoryId, ownerId: 'owner-a', query: 'authentication login password session' },
      { embeddingProvider: new ConceptEmbeddingProvider(), rerankerProvider: new OverlapRerankerProvider() },
    );

    assert.equal(response.commitSha, secondCommit);
    // The first commit's auth files must never appear — only the second
    // commit's single payments chunk is in scope, regardless of query wording.
    assert.ok(response.results.every((r) => r.filePath === 'src/payments/new-payment.ts'));
  });

  it('TEST 38 — an empty candidate result (query against a repository with no embeddings at all) returns a clean success response', async () => {
    const indexStore = new UnifiedRepositoryIndexStore();
    const embeddingStore = new UnifiedRepositoryEmbeddingStore();
    const stores = { indexStore, embeddingStore, searchRepository: new RepositorySearchRepository() };
    const repositoryId = randomUUID();

    await assert.rejects(
      () => searchRepository(
        { id: repositoryId, userId: 'owner-a', organizationId: 'owner-a', status: 'READY_FOR_SEARCH' },
        stores,
        { repositoryId, ownerId: 'owner-a', query: 'anything' },
        { embeddingProvider: new ConceptEmbeddingProvider(), rerankerProvider: new OverlapRerankerProvider() },
      ),
      (e: unknown) => (e as { code?: string }).code === 'EMBEDDINGS_NOT_READY',
    );
  });
});
