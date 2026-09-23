/**
 * BGE-M3 embedding generation — deliberately isolated from gateway.ts's
 * chat-completion logic (OrigamiAiGateway/AiRouter). Embeddings are a
 * structurally different request shape (POST {baseUrl}/embeddings with
 * {model, input}, returning {data:[{embedding:[...]}]}) than the chat
 * completions gateway.ts calls — never assume they share a request format.
 * This module never touches TASK_MODEL_MAP, callVllm, or any existing
 * Qwen routing/timeout behavior.
 */

export class EmbeddingUnavailableError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

/** The provider responded, but its payload wasn't a well-formed embeddings response (missing/malformed `data`, non-array embeddings, inconsistent per-vector dimensions). */
export class EmbeddingInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingInvalidResponseError';
  }
}

export class EmbeddingTimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'EmbeddingTimeoutError';
  }
}

/** The caller went away (its own outer timeout, or a cancelled embedding job) — distinct from EmbeddingTimeoutError, whose clock is entirely internal to this service. */
export class EmbeddingCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingCancelledError';
  }
}

export interface EmbeddingProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/**
 * AI_EMBED_MODEL is already referenced (as a fallback default) by
 * gateway.ts's TASK_MODEL_MAP.repository_search — reused here rather than
 * inventing a differently-named variable for the same concept. Embeddings
 * get their OWN timeout (AI_EMBED_TIMEOUT_MS), deliberately never
 * AI_MODEL_TIMEOUT_MS: that budget is tuned for chat-completion latency on
 * this project's dev GPU and has no reason to match an embedding call's very
 * different cost profile.
 */
export function resolveEmbeddingConfig(overrides?: Partial<EmbeddingProviderConfig>): EmbeddingProviderConfig {
  const rawTimeout = process.env.AI_EMBED_TIMEOUT_MS;
  const parsedTimeout = rawTimeout ? Number(rawTimeout) : NaN;
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 30_000;

  return {
    baseUrl: overrides?.baseUrl ?? process.env.VLLM_BASE_URL ?? 'http://localhost:8000/v1',
    apiKey: overrides?.apiKey ?? process.env.VLLM_API_KEY ?? 'not-needed',
    model: overrides?.model ?? process.env.AI_EMBED_MODEL ?? 'BGE-M3',
    timeoutMs: overrides?.timeoutMs ?? timeoutMs,
  };
}

export interface EmbeddingBatchResult {
  /** The model name the provider itself reports having used — not merely echoed back from the request, when the provider's response includes it. */
  model: string;
  dimensions: number;
  vectors: number[][];
}

/**
 * A single request/response round trip to the configured embedding model
 * server (same VLLM_BASE_URL/VLLM_API_KEY infrastructure gateway.ts already
 * uses — this is a separate embedding-specific request path over it, not a
 * new base URL or a new provider concept). Never falls back to a different
 * model: if the configured model is unavailable, this throws rather than
 * silently substituting anything else.
 */
export class BgeM3EmbeddingProvider {
  constructor(private readonly config: EmbeddingProviderConfig) {}

  get model(): string {
    return this.config.model;
  }

  /**
   * Embeds one or more texts in a single request. BGE-M3 via Ollama's
   * OpenAI-compatible endpoint natively accepts a batch `input` array
   * (verified against a real local instance during development) — this is
   * not a client-side loop over embedText.
   */
  async embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) {
      return { model: this.config.model, dimensions: 0, vectors: [] };
    }

    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ model: this.config.model, input: texts }),
        signal: combinedSignal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new EmbeddingTimeoutError(`Embedding request timed out after ${this.config.timeoutMs}ms`, this.config.timeoutMs);
      }
      // Distinguish "our own budget ran out" (timeoutSignal) from "the
      // caller went away" (the externally-supplied signal) the same way
      // gateway.ts's callVllm does for chat completions.
      if (signal?.aborted && !timeoutSignal.aborted) {
        throw new EmbeddingCancelledError('Embedding request cancelled by caller');
      }
      throw new EmbeddingUnavailableError(error instanceof Error ? error.message : 'Embedding provider unreachable');
    }

    if (!response.ok) {
      const rawDetail = await response.text().catch(() => '');
      const detail = rawDetail.length > 300 ? `${rawDetail.slice(0, 300)}…` : rawDetail;
      throw new EmbeddingUnavailableError(
        `Embedding request failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
        response.status,
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new EmbeddingInvalidResponseError('Embedding response was not valid JSON');
    }

    return this.parseResponse(data);
  }

  private parseResponse(data: unknown): EmbeddingBatchResult {
    const body = data as { model?: string; data?: Array<{ embedding?: unknown }> };
    if (!body || !Array.isArray(body.data)) {
      throw new EmbeddingInvalidResponseError('Embedding response is missing a "data" array');
    }

    const vectors: number[][] = [];
    for (const entry of body.data) {
      if (!Array.isArray(entry?.embedding) || !entry.embedding.every((v) => typeof v === 'number')) {
        throw new EmbeddingInvalidResponseError('Embedding response contained a non-numeric-array embedding');
      }
      vectors.push(entry.embedding as number[]);
    }

    const dimensions = vectors[0]?.length ?? 0;
    if (vectors.some((v) => v.length !== dimensions)) {
      throw new EmbeddingInvalidResponseError('Embedding response vectors have inconsistent dimensions within the same batch');
    }

    return { model: body.model ?? this.config.model, dimensions, vectors };
  }

  /**
   * Confirms the configured model is actually registered with the model
   * server — the same kind of check gateway.ts's checkModelAvailability
   * does for chat models, kept as an independent function here rather than
   * folded into that method (see the Phase 4 report on why this is a
   * separate embedding path).
   */
  async isModelAvailable(): Promise<{ reachable: boolean; available: boolean; availableModels: string[]; error?: string }> {
    try {
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return { reachable: false, available: false, availableModels: [], error: `HTTP ${response.status}` };
      }
      const data = (await response.json()) as { data?: Array<{ id: string }> };
      const availableModels = (data.data ?? []).map((m) => m.id);
      return { reachable: true, available: availableModels.includes(this.config.model), availableModels };
    } catch (error) {
      return { reachable: false, available: false, availableModels: [], error: error instanceof Error ? error.message : 'Model server unreachable' };
    }
  }
}
