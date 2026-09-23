import type { RepositorySearchErrorCode } from '@origami/contracts';

/**
 * The search service depends only on this interface — never on fetch/HTTP/
 * the AI Router's specific request shape directly. Mirrors
 * repository-embedding-provider.ts's EmbeddingProvider seam exactly, for
 * the same reason: the reranker backend can change later without touching
 * repository-search-service.ts at all. See HttpRerankerProvider for the
 * only production implementation, and repository-search-service.test.ts
 * for how a deterministic fake substitutes for it in tests.
 */
export interface RerankerProvider {
  readonly model: string;
  rerank(query: string, documents: string[], signal?: AbortSignal): Promise<RerankBatchResult>;
}

export interface RerankBatchResult {
  model: string;
  /** One score per input document, in the same order as `documents` — higher is more relevant. */
  scores: number[];
}

export class RerankerProviderError extends Error {
  constructor(message: string, public readonly category: RepositorySearchErrorCode) {
    super(message);
    this.name = 'RerankerProviderError';
  }
}

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

/** Never AI_CODE_GENERATION_TIMEOUT_MS or AI_MODEL_TIMEOUT_MS — reranking is its own workload with its own budget. */
export const AI_RERANKER_TIMEOUT_MS = envInt('AI_RERANKER_TIMEOUT_MS', 15_000);
/** Hard cap on how many candidates are ever sent to the reranker in one call — independent of REPOSITORY_SEARCH_CANDIDATE_K so it can be tightened separately if the reranker proves slower than vector retrieval. */
export const AI_RERANKER_MAX_CANDIDATES = envInt('AI_RERANKER_MAX_CANDIDATES', 50);

/**
 * Talks to the AI Router's dedicated POST /rerank route
 * (services/ai-router/src/index.ts), never to a reranker model server
 * directly and never to /gateway or /embed — mirrors HttpEmbeddingProvider's
 * relationship to POST /embed exactly. Model selection, timeouts, and the
 * actual bge-reranker-v2-m3 request shape all live in the AI Router; this
 * class only relays and classifies errors.
 */
export class HttpRerankerProvider implements RerankerProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private cachedModel: string | null = null;

  constructor(options: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = options.baseUrl ?? process.env.AI_ROUTER_URL ?? 'http://localhost:3102';
    this.timeoutMs = options.timeoutMs ?? AI_RERANKER_TIMEOUT_MS;
  }

  /** Best-effort label only (used for logging before the first real call) — the authoritative model name is always the one returned by rerank's response. */
  get model(): string {
    return this.cachedModel ?? process.env.AI_RERANKER_MODEL ?? 'bge-reranker-v2-m3';
  }

  async rerank(query: string, documents: string[], signal?: AbortSignal): Promise<RerankBatchResult> {
    if (documents.length === 0) return { model: this.model, scores: [] };

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, documents }),
        signal: combinedSignal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new RerankerProviderError(`Reranker request timed out after ${this.timeoutMs}ms`, 'RERANKER_TIMEOUT');
      }
      if (signal?.aborted && !timeoutSignal.aborted) {
        throw new RerankerProviderError('Reranker request cancelled by caller', 'SEARCH_FAILED');
      }
      throw new RerankerProviderError(
        error instanceof Error ? error.message : 'Reranker provider unreachable',
        'RERANKER_UNAVAILABLE',
      );
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown; errorCategory?: string };
      const message = typeof body.error === 'string' ? body.error : `Reranker request failed: HTTP ${response.status}`;
      throw new RerankerProviderError(message, this.categoryForStatus(response.status));
    }

    const data = (await response.json().catch(() => null)) as { model?: string; scores?: unknown } | null;
    if (!data || !Array.isArray(data.scores)) {
      throw new RerankerProviderError('Reranker response was missing a scores array', 'RERANKER_UNAVAILABLE');
    }

    this.cachedModel = data.model ?? this.model;
    return { model: this.cachedModel, scores: data.scores as number[] };
  }

  private categoryForStatus(status: number): RepositorySearchErrorCode {
    if (status === 504) return 'RERANKER_TIMEOUT';
    if (status === 502) return 'RERANKER_UNAVAILABLE';
    return 'RERANKER_UNAVAILABLE';
  }
}
