import type { EmbeddingErrorCategory } from '@origami/contracts';

/**
 * The rest of the repository-embedding feature (worker, service, store)
 * depends only on this interface — never on fetch/HTTP/the AI Router's
 * specific request shape directly. This is what lets the embedding backend
 * change later (a different model server, a different transport) without
 * touching repository-embedding-worker.ts at all. See HttpEmbeddingProvider
 * for the only production implementation, and repository-embedding-worker.test.ts
 * for how a deterministic fake substitutes for it in tests.
 */
export interface EmbeddingProvider {
  /** The embedding model name this provider is configured to use — never assumed by callers, always read from here. */
  readonly model: string;
  embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatchResult>;
  /** Pre-flight check: is the configured model actually registered with the model server right now? Called once at the start of an embedding job — if this reports unavailable, the job fails clearly rather than attempting (and failing) a real embedding call, and never substitutes a different model. */
  isAvailable(): Promise<{ available: boolean; reachable: boolean; error?: string }>;
}

export interface EmbeddingBatchResult {
  model: string;
  dimensions: number;
  vectors: number[][];
}

export class EmbeddingProviderError extends Error {
  constructor(message: string, public readonly category: EmbeddingErrorCategory) {
    super(message);
    this.name = 'EmbeddingProviderError';
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

/** Never AI_MODEL_TIMEOUT_MS or AI_CODE_GENERATION_TIMEOUT_MS — embeddings are a different workload with their own budget (see the Phase 4 report). */
export const AI_EMBED_TIMEOUT_MS = envInt('AI_EMBED_TIMEOUT_MS', 30_000);
export const AI_EMBED_BATCH_SIZE = envInt('AI_EMBED_BATCH_SIZE', 16);
export const AI_EMBED_MAX_INPUT_TOKENS = envInt('AI_EMBED_MAX_INPUT_TOKENS', 2000);
export const AI_EMBED_CONCURRENCY = envInt('AI_EMBED_CONCURRENCY', 2);

/**
 * Talks to the AI Router's dedicated POST /embed route (services/ai-router/src/index.ts),
 * never to a model server directly and never to /gateway — mirrors how
 * component-generator.ts calls the AI Router over HTTP rather than importing
 * gateway.ts. Model selection, timeouts, and the actual BGE-M3 request shape
 * all live in the AI Router; this class only relays and classifies errors.
 */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private cachedModel: string | null = null;

  constructor(options: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = options.baseUrl ?? process.env.AI_ROUTER_URL ?? 'http://localhost:3102';
    this.timeoutMs = options.timeoutMs ?? AI_EMBED_TIMEOUT_MS;
  }

  /** Best-effort label only (used for logging before the first real call) — the authoritative model name is always the one returned by embedBatch's response. */
  get model(): string {
    return this.cachedModel ?? process.env.AI_EMBED_MODEL ?? 'BGE-M3';
  }

  async embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) return { model: this.model, dimensions: 0, vectors: [] };

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        signal: combinedSignal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new EmbeddingProviderError(`Embedding request timed out after ${this.timeoutMs}ms`, 'EMBEDDING_TIMEOUT');
      }
      if (signal?.aborted && !timeoutSignal.aborted) {
        throw new EmbeddingProviderError('Embedding request cancelled by caller', 'EMBEDDING_CANCELLED');
      }
      throw new EmbeddingProviderError(
        error instanceof Error ? error.message : 'Embedding provider unreachable',
        'EMBEDDING_PROVIDER_UNAVAILABLE',
      );
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown; errorCategory?: EmbeddingErrorCategory };
      const category = body.errorCategory ?? this.categoryForStatus(response.status);
      const message = typeof body.error === 'string' ? body.error : `Embedding request failed: HTTP ${response.status}`;
      throw new EmbeddingProviderError(message, category);
    }

    const data = (await response.json().catch(() => null)) as { model?: string; dimensions?: number; vectors?: unknown } | null;
    if (!data || !Array.isArray(data.vectors)) {
      throw new EmbeddingProviderError('Embedding response was missing a vectors array', 'EMBEDDING_INVALID_RESPONSE');
    }

    this.cachedModel = data.model ?? this.model;
    return { model: this.cachedModel, dimensions: data.dimensions ?? 0, vectors: data.vectors as number[][] };
  }

  async isAvailable(): Promise<{ available: boolean; reachable: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/health/embedding-model`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { available: false, reachable: false, error: `HTTP ${response.status}` };
      const data = (await response.json()) as { available?: boolean; reachable?: boolean; error?: string };
      return { available: Boolean(data.available), reachable: Boolean(data.reachable), error: data.error };
    } catch (error) {
      return { available: false, reachable: false, error: error instanceof Error ? error.message : 'AI Router unreachable' };
    }
  }

  private categoryForStatus(status: number): EmbeddingErrorCategory {
    if (status === 504) return 'EMBEDDING_TIMEOUT';
    if (status === 499) return 'EMBEDDING_CANCELLED';
    if (status === 502) return 'EMBEDDING_INVALID_RESPONSE';
    return 'EMBEDDING_PROVIDER_UNAVAILABLE';
  }
}
