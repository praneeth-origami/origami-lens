/**
 * bge-reranker-v2-m3 cross-encoder reranking — deliberately isolated from
 * both gateway.ts's chat-completion logic AND embedding-provider.ts's
 * BGE-M3 embedding logic. A reranker is neither a generative model nor a
 * bi-encoder embedding model: it takes a (query, document) pair and returns
 * a single relevance score, so it needs its own request shape and its own
 * server (AI_RERANKER_BASE_URL), never /gateway and never /embed's model
 * server. This module never asks the model to explain, fix, generate, or
 * summarize anything — it only scores candidates it is given.
 */

export class RerankerUnavailableError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'RerankerUnavailableError';
  }
}

export class RerankerInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RerankerInvalidResponseError';
  }
}

export class RerankerTimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'RerankerTimeoutError';
  }
}

export class RerankerCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RerankerCancelledError';
  }
}

/**
 * Phase 7 — thrown synchronously by resolveRerankerConfig() when
 * AI_RERANKER_MAX_CANDIDATES exceeds AI_RERANKER_MAX_CLIENT_BATCH_SIZE (see
 * that function's doc comment). Deliberately NOT one of the async rerank()
 * error classes above: this is a startup/deployment misconfiguration, not a
 * per-request runtime failure, and must fail loudly (crash config
 * resolution, and therefore AI Router startup — see index.ts) rather than
 * be caught anywhere and turned into degraded-mode search.
 */
export class RerankerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RerankerConfigurationError';
  }
}

export interface RerankerProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /**
   * Phase 6 finding, verified against a real deployment: this server's
   * `/rerank` rejects the ENTIRE batch (HTTP 413) if even one document
   * exceeds its per-input token limit (8192 tokens for bge-reranker-v2-m3
   * on TEI) — there is no partial-success/skip-one-document behavior. Every
   * document is defensively truncated to this many characters before being
   * sent, so one oversized repository chunk can never fail reranking for
   * every OTHER candidate in the same request. Deliberately conservative
   * (chars, not a real tokenizer count) to leave headroom for code that
   * tokenizes more densely than prose.
   */
  maxDocumentChars: number;
  /**
   * Phase 7 — how many vector-search candidates apps/api will ever send to
   * this server in one request (mirrors apps/api/src/repository-reranker-provider.ts's
   * own AI_RERANKER_MAX_CANDIDATES, read here read-only purely to validate
   * it against maxClientBatchSize below — ai-router does not otherwise act
   * on this value; apps/api independently enforces its own copy of the
   * same env var when building the candidate list).
   */
  maxCandidates: number;
  /**
   * The real TEI server's own `--max-client-batch-size` (see
   * docker-compose.yml's `reranker` service) — the hard per-request item
   * count ceiling verified live in Phase 6 (TEI's own default of 32
   * rejected a 50-candidate batch outright with HTTP 413). This field
   * exists purely so resolveRerankerConfig() can validate maxCandidates
   * against it; BgeRerankerProvider.rerank() does not use it directly
   * (TEI itself is still the one that actually enforces the limit).
   */
  maxClientBatchSize: number;
}

export interface RerankResult {
  model: string;
  /** One score per input document, in the same order as the `documents` argument — higher is more relevant. */
  scores: number[];
}

/**
 * AI_RERANKER_BASE_URL/MODEL/TIMEOUT_MS are their own variables, never
 * reusing VLLM_BASE_URL/AI_EMBED_MODEL/AI_EMBED_TIMEOUT_MS or any chat
 * model timeout — a reranker is typically served by a completely different
 * process (e.g. a dedicated TEI/Infinity/llama.cpp-server deployment) than
 * the Ollama instance serving the chat and embedding models in this
 * project's development environment.
 */
/**
 * Phase 7 — Reranker Configuration Safety.
 *
 * Phase 6 verified live that the real TEI server rejects an ENTIRE rerank
 * request (HTTP 413) if the candidate count exceeds its own
 * `--max-client-batch-size`, and fixed this by raising that server setting
 * to 64 (docker-compose.yml) to comfortably fit apps/api's default
 * AI_RERANKER_MAX_CANDIDATES=50. That fix only holds as long as the two
 * numbers stay in the right relationship — nothing previously stopped a
 * later change from raising AI_RERANKER_MAX_CANDIDATES past
 * AI_RERANKER_MAX_CLIENT_BATCH_SIZE, which would silently push every real
 * search into permanent vector-only degraded mode (every rerank request
 * would 413, apps/api would catch that as RerankerProviderError, and search
 * would keep "working" with visibly-lower-quality ranking and no error
 * anywhere). This function now validates that relationship at config-
 * resolution time (i.e. at AI Router startup — see index.ts's top-level
 * `resolveRerankerConfig()` call) and throws RerankerConfigurationError
 * instead, so a bad deployment configuration fails loudly and immediately
 * rather than degrading search quality invisibly. No network call is made
 * to discover the server's real limit — both sides of the comparison come
 * from local configuration only.
 */
export function resolveRerankerConfig(overrides?: Partial<RerankerProviderConfig>): RerankerProviderConfig {
  const rawTimeout = process.env.AI_RERANKER_TIMEOUT_MS;
  const parsedTimeout = rawTimeout ? Number(rawTimeout) : NaN;
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 15_000;

  const rawMaxDocumentChars = process.env.AI_RERANKER_MAX_DOCUMENT_CHARS;
  const parsedMaxDocumentChars = rawMaxDocumentChars ? Number(rawMaxDocumentChars) : NaN;
  const maxDocumentChars = Number.isFinite(parsedMaxDocumentChars) && parsedMaxDocumentChars > 0 ? parsedMaxDocumentChars : 6_000;

  // Same permissive-per-field parsing as timeoutMs/maxDocumentChars above:
  // a missing, non-numeric, zero, or negative raw value silently falls back
  // to this field's own safe default — never throws on its own. Only the
  // RELATIONSHIP between the two resolved numbers (checked further below)
  // is treated as a hard configuration error.
  const rawMaxCandidates = process.env.AI_RERANKER_MAX_CANDIDATES;
  const parsedMaxCandidates = rawMaxCandidates ? Number(rawMaxCandidates) : NaN;
  const maxCandidates = Number.isFinite(parsedMaxCandidates) && parsedMaxCandidates > 0 ? parsedMaxCandidates : 50;

  const rawMaxClientBatchSize = process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE;
  const parsedMaxClientBatchSize = rawMaxClientBatchSize ? Number(rawMaxClientBatchSize) : NaN;
  const maxClientBatchSize = Number.isFinite(parsedMaxClientBatchSize) && parsedMaxClientBatchSize > 0 ? parsedMaxClientBatchSize : 64;

  const resolvedMaxCandidates = overrides?.maxCandidates ?? maxCandidates;
  const resolvedMaxClientBatchSize = overrides?.maxClientBatchSize ?? maxClientBatchSize;

  if (resolvedMaxCandidates > resolvedMaxClientBatchSize) {
    throw new RerankerConfigurationError(
      `AI_RERANKER_MAX_CANDIDATES (${resolvedMaxCandidates}) exceeds AI_RERANKER_MAX_CLIENT_BATCH_SIZE (${resolvedMaxClientBatchSize}). ` +
        'Increase AI_RERANKER_MAX_CLIENT_BATCH_SIZE (and the matching --max-client-batch-size argument for the reranker service in docker-compose.yml) or reduce AI_RERANKER_MAX_CANDIDATES.',
    );
  }

  return {
    baseUrl: overrides?.baseUrl ?? process.env.AI_RERANKER_BASE_URL ?? 'http://localhost:8001',
    apiKey: overrides?.apiKey ?? process.env.AI_RERANKER_API_KEY ?? 'not-needed',
    model: overrides?.model ?? process.env.AI_RERANKER_MODEL ?? 'bge-reranker-v2-m3',
    timeoutMs: overrides?.timeoutMs ?? timeoutMs,
    maxDocumentChars: overrides?.maxDocumentChars ?? maxDocumentChars,
    maxCandidates: resolvedMaxCandidates,
    maxClientBatchSize: resolvedMaxClientBatchSize,
  };
}

/**
 * A single request/response round trip to the configured reranker server.
 *
 * Phase 6 UPDATE: the outbound wire format below is now VERIFIED against a
 * real bge-reranker-v2-m3 deployment (Hugging Face Text Embeddings
 * Inference, `ghcr.io/huggingface/text-embeddings-inference:86-1.8`,
 * running locally with GPU acceleration — see the Phase 6 report). The
 * Phase 5 assumption (`{model, query, documents}` request, `{results:
 * [{index, relevance_score}]}` response) turned out to be WRONG on the
 * request side: TEI's `/rerank` requires the field name `texts`, not
 * `documents`, and rejects `documents` outright with HTTP 422 ("missing
 * field `texts`"). It also has no use for a `model` field (one model per
 * server instance), so that field is no longer sent. The response side
 * needed no change — TEI returns a bare `[{index, score}]` array, which
 * `parseScores`/`extractEntries` below already handled defensively without
 * ever having seen a real response. Kept generic (still accepting
 * `{results: [...]}` and `relevance_score` as alternates) in case a future
 * deployment swaps to a different reranker server (Infinity, a
 * Cohere-compatible API) with a different exact shape.
 */
export class BgeRerankerProvider {
  constructor(private readonly config: RerankerProviderConfig) {}

  get model(): string {
    return this.config.model;
  }

  async rerank(query: string, documents: string[], signal?: AbortSignal): Promise<RerankResult> {
    if (documents.length === 0) {
      return { model: this.config.model, scores: [] };
    }

    // See RerankerProviderConfig.maxDocumentChars: one oversized document
    // fails the whole batch on the real server, verified via HTTP 413
    // ("`inputs` must have less than 8192 tokens") during Phase 6 testing.
    const texts = documents.map((d) => (d.length > this.config.maxDocumentChars ? d.slice(0, this.config.maxDocumentChars) : d));

    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ query, texts }),
        signal: combinedSignal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new RerankerTimeoutError(`Reranker request timed out after ${this.config.timeoutMs}ms`, this.config.timeoutMs);
      }
      if (signal?.aborted && !timeoutSignal.aborted) {
        throw new RerankerCancelledError('Reranker request cancelled by caller');
      }
      throw new RerankerUnavailableError(error instanceof Error ? error.message : 'Reranker provider unreachable');
    }

    if (!response.ok) {
      const rawDetail = await response.text().catch(() => '');
      const detail = rawDetail.length > 300 ? `${rawDetail.slice(0, 300)}…` : rawDetail;
      throw new RerankerUnavailableError(
        `Reranker request failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
        response.status,
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new RerankerInvalidResponseError('Reranker response was not valid JSON');
    }

    return { model: this.config.model, scores: this.parseScores(data, documents.length) };
  }

  /** Accepts both `{results:[{index,relevance_score}]}` and a bare `[{index,score}]` array — the latter is what the real, verified TEI deployment actually returns (see the Phase 6 report); the former is kept as a defensive alternate for a differently-shaped server. */
  private parseScores(data: unknown, expectedCount: number): number[] {
    const entries = this.extractEntries(data);
    if (!entries) {
      throw new RerankerInvalidResponseError('Reranker response did not contain a recognizable results array');
    }

    const scores = new Array<number | undefined>(expectedCount).fill(undefined);
    for (const entry of entries) {
      const index = entry.index;
      const score = entry.relevance_score ?? entry.score;
      if (typeof index !== 'number' || typeof score !== 'number' || index < 0 || index >= expectedCount) {
        throw new RerankerInvalidResponseError('Reranker response contained a malformed result entry');
      }
      scores[index] = score;
    }

    if (scores.some((s) => s === undefined)) {
      throw new RerankerInvalidResponseError('Reranker response did not score every candidate document');
    }
    return scores as number[];
  }

  private extractEntries(data: unknown): Array<{ index?: unknown; relevance_score?: unknown; score?: unknown }> | null {
    if (Array.isArray(data)) return data;
    const body = data as { results?: unknown };
    if (body && Array.isArray(body.results)) return body.results as Array<{ index?: unknown; relevance_score?: unknown; score?: unknown }>;
    return null;
  }

  /** Best-effort reachability check — no standardized "list models" endpoint exists across reranker server implementations the way OpenAI-compat chat/embedding servers have one, so this only confirms the configured base URL responds to a conventional health check, not that the specific model name is loaded. */
  async isAvailable(): Promise<{ reachable: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.config.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
      return { reachable: response.ok, error: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (error) {
      return { reachable: false, error: error instanceof Error ? error.message : 'Reranker server unreachable' };
    }
  }
}
