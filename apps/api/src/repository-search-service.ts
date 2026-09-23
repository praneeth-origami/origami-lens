import type { RepositorySearchErrorCode, RepositorySearchResponse, RepositorySearchResult } from '@origami/contracts';
import { EmbeddingProviderError, HttpEmbeddingProvider, type EmbeddingProvider } from './repository-embedding-provider.js';
import { AI_RERANKER_MAX_CANDIDATES, HttpRerankerProvider, RerankerProviderError, type RerankerProvider } from './repository-reranker-provider.js';
import { buildEmbeddingInput } from './repository-embedding-service.js';
import { isSensitiveFile } from './repository-file-safety.js';
import { canAccessRepository } from './repository-service.js';
import { RepositorySearchRepository, type VectorSearchCandidate } from './db/repository-search-repository.js';
import type { UnifiedRepositoryEmbeddingStore } from './unified-repository-embedding-store.js';
import type { UnifiedRepositoryIndexStore } from './unified-repository-index-store.js';

function envInt(name: string, defaultValue: number, minValue = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    console.error(JSON.stringify({ event: 'invalid_repository_config', name, providedValue: raw, minValue, fallback: defaultValue }));
    return defaultValue;
  }
  return parsed;
}

export const REPOSITORY_SEARCH_MAX_QUERY_LENGTH = envInt('REPOSITORY_SEARCH_MAX_QUERY_LENGTH', 500);
/** Bounded candidate set retrieved from pgvector before reranking — never rerank (or return) the entire repository. */
export const REPOSITORY_SEARCH_CANDIDATE_K = envInt('REPOSITORY_SEARCH_CANDIDATE_K', 50);
/** Hard ceiling on the final response's result count, regardless of what a caller requests via `limit`. */
export const REPOSITORY_SEARCH_RESULT_LIMIT = envInt('REPOSITORY_SEARCH_RESULT_LIMIT', 10);
/** Chunk content returned to the API is truncated to this many characters — never a full file, never unbounded. */
export const REPOSITORY_SEARCH_MAX_CONTENT_CHARS = envInt('REPOSITORY_SEARCH_MAX_CONTENT_CHARS', 600);
/** Its own budget — never AI_EMBED_TIMEOUT_MS (Phase 4's document-embedding batch timeout) or any chat-model timeout. A query embedding is a single short string, not a batch of chunks, so it can reasonably use a tighter budget. */
export const AI_QUERY_EMBEDDING_TIMEOUT_MS = envInt('AI_QUERY_EMBEDDING_TIMEOUT_MS', 10_000);

export class SearchError extends Error {
  constructor(message: string, public readonly code: RepositorySearchErrorCode) {
    super(message);
    this.name = 'SearchError';
  }
}

/** Trims whitespace, requires a non-empty string, and enforces REPOSITORY_SEARCH_MAX_QUERY_LENGTH — never logs the raw query (see logSearchCompleted below), only its length. */
export function validateSearchQuery(rawQuery: unknown): string {
  if (typeof rawQuery !== 'string') {
    throw new SearchError('query is required and must be a string.', 'SEARCH_QUERY_INVALID');
  }
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    throw new SearchError('query must not be empty.', 'SEARCH_QUERY_INVALID');
  }
  if (trimmed.length > REPOSITORY_SEARCH_MAX_QUERY_LENGTH) {
    throw new SearchError(`query must be ${REPOSITORY_SEARCH_MAX_QUERY_LENGTH} characters or fewer.`, 'SEARCH_QUERY_INVALID');
  }
  return trimmed;
}

/** A caller-requested limit is honored only up to REPOSITORY_SEARCH_RESULT_LIMIT — never unlimited, never negative/zero/NaN. */
export function clampResultLimit(rawLimit: unknown): number {
  if (rawLimit === undefined || rawLimit === null) return REPOSITORY_SEARCH_RESULT_LIMIT;
  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed) || parsed <= 0) return REPOSITORY_SEARCH_RESULT_LIMIT;
  return Math.min(Math.floor(parsed), REPOSITORY_SEARCH_RESULT_LIMIT);
}

function truncateContent(content: string): string {
  return content.length <= REPOSITORY_SEARCH_MAX_CONTENT_CHARS ? content : `${content.slice(0, REPOSITORY_SEARCH_MAX_CONTENT_CHARS)}…`;
}

/** Structured, non-sensitive performance/lifecycle log — never the query text, chunk content, or vectors. */
function logSearchCompleted(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: 'repository_search_completed', ...fields }));
}

export interface RepositorySearchStores {
  embeddingStore: Pick<UnifiedRepositoryEmbeddingStore, 'getLatestForRepositoryAsync' | 'getEmbeddingsForCommitLegacy'>;
  indexStore: Pick<UnifiedRepositoryIndexStore, 'getChunksForJobAsync'>;
  searchRepository: RepositorySearchRepository;
}

export interface SearchProviderDeps {
  embeddingProvider: EmbeddingProvider;
  rerankerProvider: RerankerProvider;
}

export function defaultSearchProviderDeps(): SearchProviderDeps {
  return {
    embeddingProvider: new HttpEmbeddingProvider({ timeoutMs: AI_QUERY_EMBEDDING_TIMEOUT_MS }),
    rerankerProvider: new HttpRerankerProvider(),
  };
}

export interface SearchRequestParams {
  repositoryId: string;
  ownerId?: string;
  query: unknown;
  limit?: unknown;
}

/** Repository statuses that mean "never successfully indexed yet" — distinguished from EMBEDDINGS_NOT_READY (indexed, but no completed embedding set), matching the two distinct error codes the spec requires. */
const NOT_YET_INDEXED_STATUSES = new Set(['CONNECTED', 'DISCONNECTED', 'CLONING', 'READY_FOR_INDEXING', 'INDEXING', 'FAILED']);

/**
 * Cosine distance between two equal-length vectors — used only by the
 * no-Postgres legacy fallback path (see searchByVectorFallback below). The
 * real production path always uses pgvector's native `<=>` operator via
 * RepositorySearchRepository instead; this exists purely so the feature is
 * testable/usable without a live Postgres instance, mirroring every other
 * phase's legacy-store convention.
 */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function searchByVectorFallback(
  stores: RepositorySearchStores,
  indexJobId: string,
  repositoryId: string,
  commitSha: string,
  model: string,
  queryVector: number[],
  limit: number,
): Promise<VectorSearchCandidate[]> {
  const embeddings = stores.embeddingStore.getEmbeddingsForCommitLegacy(repositoryId, commitSha, model);
  if (embeddings.length === 0) return [];

  const chunks = await stores.indexStore.getChunksForJobAsync(indexJobId);
  const chunksById = new Map(chunks.map((c) => [c.id, c]));

  return embeddings
    .map((e) => {
      const chunk = chunksById.get(e.chunkId);
      if (!chunk) return null;
      const candidate: VectorSearchCandidate = {
        chunkId: e.chunkId,
        filePath: chunk.filePath,
        language: chunk.language,
        symbol: chunk.symbol,
        symbolType: chunk.symbolType,
        parentSymbol: chunk.parentSymbol,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        isExported: chunk.isExported,
        content: chunk.content,
        vectorDistance: cosineDistance(queryVector, e.vector),
      };
      return candidate;
    })
    .filter((c): c is VectorSearchCandidate => c !== null)
    .sort((a, b) => a.vectorDistance - b.vectorDistance)
    .slice(0, limit);
}

/**
 * Orchestrates: query validation -> BGE-M3 query embedding -> pgvector
 * candidate retrieval -> bge-reranker-v2-m3 reranking -> bounded result
 * formatting. Depends only on the EmbeddingProvider/RerankerProvider
 * interfaces (never a specific HTTP client), so tests substitute
 * deterministic fakes for both — see repository-search-service.test.ts.
 */
export async function searchRepository(
  repository: { id: string; ownerId?: string; userId?: string; organizationId?: string; status: string } | undefined,
  stores: RepositorySearchStores,
  params: SearchRequestParams,
  deps: SearchProviderDeps = defaultSearchProviderDeps(),
  signal?: AbortSignal,
): Promise<RepositorySearchResponse> {
  const startedAt = Date.now();

  const query = validateSearchQuery(params.query);
  const limit = clampResultLimit(params.limit);

  if (!repository) {
    throw new SearchError('Repository not found.', 'REPOSITORY_NOT_FOUND');
  }
  if (!canAccessRepository(repository.organizationId, params.ownerId)) {
    // Same "not found" response whether the repository truly doesn't exist
    // or simply doesn't belong to this owner — never confirms existence to
    // a caller it doesn't belong to (matches every other repository route).
    throw new SearchError('Repository not found.', 'REPOSITORY_ACCESS_DENIED');
  }
  if (NOT_YET_INDEXED_STATUSES.has(repository.status)) {
    throw new SearchError('Repository must be indexed before it can be searched.', 'REPOSITORY_NOT_READY');
  }

  const embeddingJob = await stores.embeddingStore.getLatestForRepositoryAsync(repository.id);
  if (!embeddingJob || embeddingJob.status !== 'COMPLETED') {
    throw new SearchError('Repository embeddings are not ready yet.', 'EMBEDDINGS_NOT_READY');
  }
  const commitSha = embeddingJob.commitSha;
  const model = embeddingJob.model;

  let queryVector: number[];
  let dimensions: number;
  let embeddingDurationMs: number;
  {
    const t0 = Date.now();
    try {
      const result = await deps.embeddingProvider.embedBatch([query], signal);
      if (!result.vectors[0]) {
        throw new SearchError('Query embedding returned no vector.', 'EMBEDDING_PROVIDER_UNAVAILABLE');
      }
      queryVector = result.vectors[0];
      dimensions = result.dimensions;
    } catch (error) {
      if (error instanceof SearchError) throw error;
      if (error instanceof EmbeddingProviderError) {
        const code: RepositorySearchErrorCode = error.category === 'EMBEDDING_TIMEOUT' ? 'EMBEDDING_TIMEOUT' : 'EMBEDDING_PROVIDER_UNAVAILABLE';
        throw new SearchError(error.message, code);
      }
      throw new SearchError('Query embedding failed.', 'EMBEDDING_PROVIDER_UNAVAILABLE');
    }
    embeddingDurationMs = Date.now() - t0;
  }

  // Never truncate or pad the query vector — a dimension mismatch against
  // the stored embeddings is a controlled failure, not silently ignored.
  if (embeddingJob.dimensions !== undefined && dimensions !== embeddingJob.dimensions) {
    throw new SearchError(
      `Query embedding dimension (${dimensions}) does not match the repository's stored embedding dimension (${embeddingJob.dimensions}).`,
      'VECTOR_SEARCH_FAILED',
    );
  }

  let candidates: VectorSearchCandidate[];
  let vectorSearchDurationMs: number;
  {
    const t0 = Date.now();
    try {
      candidates = stores.searchRepository.isEnabled()
        ? await stores.searchRepository.searchByVector({ repositoryId: repository.id, commitSha, model, queryVector, limit: REPOSITORY_SEARCH_CANDIDATE_K })
        : await searchByVectorFallback(stores, embeddingJob.indexJobId, repository.id, commitSha, model, queryVector, REPOSITORY_SEARCH_CANDIDATE_K);
    } catch (error) {
      if (error instanceof SearchError) throw error;
      throw new SearchError('Vector search failed.', 'VECTOR_SEARCH_FAILED');
    }
    vectorSearchDurationMs = Date.now() - t0;
  }

  // Defense in depth: Phase 3 already excludes sensitive files from
  // indexing entirely, so this should never actually filter anything out —
  // but search must never rely solely on an upstream guarantee for this.
  candidates = candidates.filter((c) => !isSensitiveFile(c.filePath));

  if (candidates.length === 0) {
    logSearchCompleted({
      repositoryId: repository.id, commitSha, candidateCount: 0, resultCount: 0,
      embeddingDurationMs, vectorSearchDurationMs, rerankerDurationMs: 0,
      totalDurationMs: Date.now() - startedAt, reranked: false,
    });
    return { repositoryId: repository.id, commitSha, query, results: [], candidateCount: 0, reranked: false };
  }

  const rerankCandidates = candidates.slice(0, AI_RERANKER_MAX_CANDIDATES);
  let reranked = false;
  let rerankerDurationMs = 0;
  let ordered: Array<VectorSearchCandidate & { rerankerScore?: number }>;

  try {
    const t0 = Date.now();
    const documents = rerankCandidates.map((c) =>
      buildEmbeddingInput({ filePath: c.filePath, language: c.language, symbol: c.symbol, symbolType: c.symbolType, startLine: c.startLine, endLine: c.endLine, content: c.content }),
    );
    const rerankResult = await deps.rerankerProvider.rerank(query, documents, signal);
    rerankerDurationMs = Date.now() - t0;
    ordered = rerankCandidates
      .map((c, i) => ({ ...c, rerankerScore: rerankResult.scores[i] }))
      .sort((a, b) => (b.rerankerScore ?? -Infinity) - (a.rerankerScore ?? -Infinity));
    reranked = true;
  } catch (error) {
    // Explicit degraded fallback (never a silent misrepresentation): a
    // recognized reranker failure mode (unavailable/timeout/cancelled/
    // invalid response) falls back to the already-nearest-first vector
    // ordering, with `reranked: false` in the response — an unexpected
    // error class still fails the whole search rather than pretending
    // degraded ranking is fine for a bug we don't understand.
    if (!(error instanceof RerankerProviderError)) {
      throw new SearchError('Search failed unexpectedly during reranking.', 'SEARCH_FAILED');
    }
    ordered = rerankCandidates.map((c) => ({ ...c }));
    reranked = false;
  }

  const results: RepositorySearchResult[] = ordered.slice(0, limit).map((c) => ({
    chunkId: c.chunkId,
    filePath: c.filePath,
    language: c.language,
    symbol: c.symbol,
    symbolType: c.symbolType,
    parentSymbol: c.parentSymbol ?? undefined,
    startLine: c.startLine,
    endLine: c.endLine,
    isExported: c.isExported,
    vectorDistance: c.vectorDistance,
    rerankerScore: c.rerankerScore,
    content: truncateContent(c.content),
  }));

  const totalDurationMs = Date.now() - startedAt;
  logSearchCompleted({
    repositoryId: repository.id, commitSha, candidateCount: candidates.length, resultCount: results.length,
    embeddingDurationMs, vectorSearchDurationMs, rerankerDurationMs, totalDurationMs, reranked,
  });

  return { repositoryId: repository.id, commitSha, query, results, candidateCount: candidates.length, reranked };
}
