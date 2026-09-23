import type { RepositoryAskErrorCode } from '@origami/contracts';

/**
 * Talks to the AI Router's dedicated POST /answer-repository-question route
 * (services/ai-router/src/index.ts), never to a model server directly and
 * never to /gateway — mirrors HttpIssueAnalysisProvider's relationship to
 * POST /analyze-repository-issue (Phase 8) exactly. repository-ai-service.ts
 * depends only on this interface, never on fetch/HTTP directly.
 */
export interface RepositoryQaProvider {
  readonly model: string;
  answer(request: RepositoryQaProviderRequest, signal?: AbortSignal): Promise<RepositoryQaProviderResult>;
}

export interface RepositoryQaProviderRequest {
  query: string;
  contextText: string;
}

export interface RepositoryQaProviderResult {
  model: string;
  answer: string;
}

export class RepositoryQaProviderError extends Error {
  constructor(message: string, public readonly category: RepositoryAskErrorCode) {
    super(message);
    this.name = 'RepositoryQaProviderError';
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

/** Its own dedicated budget — kept slightly above the AI Router's own AI_REPOSITORY_QA_TIMEOUT_MS default (60s), same pattern as Phase 8's AI_ISSUE_ANALYSIS_CLIENT_TIMEOUT_MS. */
export const AI_REPOSITORY_QA_CLIENT_TIMEOUT_MS = envInt('AI_REPOSITORY_QA_CLIENT_TIMEOUT_MS', 65_000);

export class HttpRepositoryQaProvider implements RepositoryQaProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private cachedModel: string | null = null;

  constructor(options: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = options.baseUrl ?? process.env.AI_ROUTER_URL ?? 'http://localhost:3102';
    this.timeoutMs = options.timeoutMs ?? AI_REPOSITORY_QA_CLIENT_TIMEOUT_MS;
  }

  /** Best-effort label only (used for logging before the first real call) — the authoritative model name is always the one returned by answer's response. */
  get model(): string {
    return this.cachedModel ?? process.env.AI_TEXT_MODEL ?? 'qwen2.5:7b';
  }

  async answer(request: RepositoryQaProviderRequest, signal?: AbortSignal): Promise<RepositoryQaProviderResult> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/answer-repository-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: combinedSignal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new RepositoryQaProviderError(`Repository Q&A request timed out after ${this.timeoutMs}ms`, 'LLM_TIMEOUT');
      }
      if (signal?.aborted && !timeoutSignal.aborted) {
        throw new RepositoryQaProviderError('Repository Q&A request cancelled by caller', 'ASK_FAILED');
      }
      throw new RepositoryQaProviderError(error instanceof Error ? error.message : 'Repository Q&A provider unreachable', 'LLM_PROVIDER_UNAVAILABLE');
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      const message = typeof body.error === 'string' ? body.error : `Repository Q&A request failed: HTTP ${response.status}`;
      const category: RepositoryAskErrorCode = response.status === 504 ? 'LLM_TIMEOUT' : 'LLM_PROVIDER_UNAVAILABLE';
      throw new RepositoryQaProviderError(message, category);
    }

    const data = (await response.json().catch(() => null)) as RepositoryQaProviderResult | null;
    if (!data || typeof data.answer !== 'string' || !data.answer.trim()) {
      throw new RepositoryQaProviderError('Repository Q&A response was malformed', 'ASK_FAILED');
    }

    this.cachedModel = data.model ?? this.model;
    return { model: this.cachedModel, answer: data.answer };
  }
}
