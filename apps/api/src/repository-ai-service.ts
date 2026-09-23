import type { RepositoryAskErrorCode, RepositoryAskResponse, RepositoryAskSource } from '@origami/contracts';
import { SearchError, searchRepository, type RepositorySearchStores, type SearchProviderDeps } from './repository-search-service.js';
import { buildRepositoryQaContext, type RepositoryContextChunk } from './repository-ai-context.js';
import { RepositoryQaProviderError, type RepositoryQaProvider } from './repository-qa-provider.js';
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

/** How many top reranked candidates repository Q&A requests from the existing search pipeline before context-bounding — independent of REPOSITORY_SEARCH_RESULT_LIMIT so it can be tuned separately (a good answer may benefit from a few more candidate chunks than the search UI displays at once). */
export const AI_REPOSITORY_QA_MAX_RESULT_CHUNKS = envInt('AI_REPOSITORY_QA_MAX_RESULT_CHUNKS', 10);

const INSUFFICIENT_EVIDENCE_ANSWER = "I couldn't determine this confidently from the indexed repository context.";

export class AskError extends Error {
  constructor(message: string, public readonly code: RepositoryAskErrorCode) {
    super(message);
    this.name = 'AskError';
  }
}

/** Maps every SearchError code Phase 5 can throw onto the Phase 9 RepositoryAskErrorCode union — this IS the reuse: repository Q&A never re-implements validation/embedding/vector-search/degraded-mode logic, it only relabels the same failure taxonomy for its own response contract. */
function mapSearchErrorCode(code: string): RepositoryAskErrorCode {
  switch (code) {
    case 'REPOSITORY_NOT_FOUND':
    case 'REPOSITORY_ACCESS_DENIED':
    case 'REPOSITORY_NOT_READY':
    case 'EMBEDDINGS_NOT_READY':
    case 'EMBEDDING_PROVIDER_UNAVAILABLE':
    case 'EMBEDDING_TIMEOUT':
    case 'VECTOR_SEARCH_FAILED':
      return code as RepositoryAskErrorCode;
    case 'SEARCH_QUERY_INVALID':
      return 'ASK_QUERY_INVALID';
    default:
      // RERANKER_UNAVAILABLE/RERANKER_TIMEOUT never reach here — searchRepository()
      // catches those internally and returns reranked:false instead of throwing
      // (see repository-search-service.ts). Anything else (including
      // SEARCH_FAILED) is an unexpected failure from Q&A's point of view.
      return 'ASK_FAILED';
  }
}

export interface RepositoryAskStores extends RepositorySearchStores {
  indexStore: Pick<UnifiedRepositoryIndexStore, 'getChunksForJobAsync' | 'getLatestForCommitAsync'>;
}

export interface AskProviderDeps extends SearchProviderDeps {
  qaProvider: RepositoryQaProvider;
}

export interface AskRequestParams {
  repositoryId: string;
  ownerId?: string;
  query: unknown;
}

function logAskCompleted(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: 'repository_ask_completed', ...fields }));
}

/**
 * Orchestrates: reuse searchRepository() (Phase 5/6, unchanged, handles
 * query validation/ownership/readiness/embedding/pgvector/reranking/
 * degraded-mode/sensitive-file-filtering) -> fetch full (untruncated) chunk
 * content for the returned chunkIds -> build bounded LLM context -> call
 * the Phase 9 Q&A provider -> return a grounded answer with real source
 * metadata. Never re-implements retrieval; only adds context-building and
 * the LLM call on top of Phase 5/6's existing response.
 */
export async function answerRepositoryQuestion(
  repository: { id: string; ownerId?: string; status: string } | undefined,
  stores: RepositoryAskStores,
  params: AskRequestParams,
  deps: AskProviderDeps,
  signal?: AbortSignal,
): Promise<RepositoryAskResponse> {
  const startedAt = Date.now();

  let searchDurationMs: number;
  let searchResponse;
  {
    const t0 = Date.now();
    try {
      searchResponse = await searchRepository(
        repository,
        stores,
        { repositoryId: params.repositoryId, ownerId: params.ownerId, query: params.query, limit: AI_REPOSITORY_QA_MAX_RESULT_CHUNKS },
        { embeddingProvider: deps.embeddingProvider, rerankerProvider: deps.rerankerProvider },
        signal,
      );
    } catch (error) {
      if (error instanceof SearchError) {
        throw new AskError(error.message, mapSearchErrorCode(error.code));
      }
      throw new AskError('Repository search failed unexpectedly.', 'ASK_FAILED');
    }
    searchDurationMs = Date.now() - t0;
  }

  if (searchResponse.results.length === 0) {
    logAskCompleted({
      repositoryId: repository!.id, commitSha: searchResponse.commitSha, candidateCount: 0, resultCount: 0,
      searchDurationMs, contextBuildDurationMs: 0, llmDurationMs: 0, totalDurationMs: Date.now() - startedAt, reranked: false, sourceCount: 0,
    });
    return {
      repositoryId: repository!.id, commitSha: searchResponse.commitSha, query: searchResponse.query,
      answer: INSUFFICIENT_EVIDENCE_ANSWER, sources: [], candidateCount: 0, resultCount: 0, reranked: false,
    };
  }

  // Search's own response content is truncated for its own display purposes
  // (REPOSITORY_SEARCH_MAX_CONTENT_CHARS) — Q&A needs the full, untruncated
  // chunk content to build good context, so the exact same chunks are
  // re-fetched by chunkId from the same index job the search already
  // resolved (searchResponse.commitSha), never a second independent lookup
  // of "what's relevant", only a full-content lookup for chunks Phase 5/6
  // already selected.
  let contextBuildDurationMs: number;
  let contextChunks: RepositoryContextChunk[];
  {
    const t0 = Date.now();
    const indexJob = await stores.indexStore.getLatestForCommitAsync(repository!.id, searchResponse.commitSha);
    const fullContentByChunkId = new Map<string, string>();
    if (indexJob) {
      const chunks = await stores.indexStore.getChunksForJobAsync(indexJob.jobId);
      for (const chunk of chunks) fullContentByChunkId.set(chunk.id, chunk.content);
    }
    contextChunks = searchResponse.results.map((r) => ({
      filePath: r.filePath, language: r.language, symbol: r.symbol, symbolType: r.symbolType,
      startLine: r.startLine, endLine: r.endLine, content: fullContentByChunkId.get(r.chunkId) ?? r.content ?? '',
    }));
    contextBuildDurationMs = Date.now() - t0;
  }

  const { contextText, includedChunks } = buildRepositoryQaContext(contextChunks);

  let answer: string;
  let model: string | undefined;
  let llmDurationMs: number;
  {
    const t0 = Date.now();
    try {
      const result = await deps.qaProvider.answer({ query: searchResponse.query, contextText }, signal);
      answer = result.answer;
      model = result.model;
    } catch (error) {
      if (error instanceof RepositoryQaProviderError) {
        throw new AskError(error.message, error.category);
      }
      throw new AskError('Repository Q&A failed unexpectedly.', 'ASK_FAILED');
    }
    llmDurationMs = Date.now() - t0;
  }

  const sources: RepositoryAskSource[] = includedChunks.map((c) => ({
    filePath: c.filePath, symbol: c.symbol, symbolType: c.symbolType, startLine: c.startLine, endLine: c.endLine,
  }));

  const totalDurationMs = Date.now() - startedAt;
  logAskCompleted({
    repositoryId: repository!.id, commitSha: searchResponse.commitSha, candidateCount: searchResponse.candidateCount,
    resultCount: searchResponse.results.length, sourceCount: sources.length, reranked: searchResponse.reranked,
    searchDurationMs, contextBuildDurationMs, llmDurationMs, totalDurationMs,
  });

  return {
    repositoryId: repository!.id, commitSha: searchResponse.commitSha, query: searchResponse.query,
    answer, sources, candidateCount: searchResponse.candidateCount, resultCount: sources.length,
    reranked: searchResponse.reranked, model,
  };
}
