import type { ElementActionErrorCode, ElementActionType } from '@origami/contracts';

/**
 * Talks to the AI Router's dedicated POST /answer-element-question route
 * (services/ai-router/src/index.ts), never to a model server directly and
 * never to /gateway — mirrors HttpPageQaProvider's relationship to
 * POST /answer-page-question exactly. element-action-service.ts depends
 * only on this interface, never on fetch/HTTP directly.
 */
export interface ElementQaProvider {
  readonly model: string;
  answer(request: ElementQaProviderRequest, signal?: AbortSignal): Promise<ElementQaProviderResult>;
}

export interface ElementQaProviderRequest {
  action: ElementActionType;
  contextText: string;
  instruction?: string;
}

export interface ElementQaProviderResult {
  model: string;
  answer: string;
}

export class ElementQaProviderError extends Error {
  constructor(message: string, public readonly category: ElementActionErrorCode) {
    super(message);
    this.name = 'ElementQaProviderError';
  }
}

function envInt(name: string, defaultValue: number, minValue = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    console.error(JSON.stringify({ event: 'invalid_element_qa_config', name, providedValue: raw, minValue, fallback: defaultValue }));
    return defaultValue;
  }
  return parsed;
}

/** Its own dedicated budget — same pattern as AI_PAGE_QA_CLIENT_TIMEOUT_MS. */
export const AI_ELEMENT_QA_CLIENT_TIMEOUT_MS = envInt('AI_ELEMENT_QA_CLIENT_TIMEOUT_MS', 65_000);

export class HttpElementQaProvider implements ElementQaProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private cachedModel: string | null = null;

  constructor(options: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = options.baseUrl ?? process.env.AI_ROUTER_URL ?? 'http://localhost:3102';
    this.timeoutMs = options.timeoutMs ?? AI_ELEMENT_QA_CLIENT_TIMEOUT_MS;
  }

  get model(): string {
    return this.cachedModel ?? process.env.AI_TEXT_MODEL ?? 'qwen2.5:7b';
  }

  async answer(request: ElementQaProviderRequest, signal?: AbortSignal): Promise<ElementQaProviderResult> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/answer-element-question`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: combinedSignal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new ElementQaProviderError(`Element action request timed out after ${this.timeoutMs}ms`, 'LLM_TIMEOUT');
      }
      if (signal?.aborted && !timeoutSignal.aborted) {
        throw new ElementQaProviderError('Element action request cancelled by caller', 'ACTION_FAILED');
      }
      throw new ElementQaProviderError(error instanceof Error ? error.message : 'Element action provider unreachable', 'LLM_PROVIDER_UNAVAILABLE');
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      const message = typeof body.error === 'string' ? body.error : `Element action request failed: HTTP ${response.status}`;
      const category: ElementActionErrorCode = response.status === 504 ? 'LLM_TIMEOUT' : 'LLM_PROVIDER_UNAVAILABLE';
      throw new ElementQaProviderError(message, category);
    }

    const data = (await response.json().catch(() => null)) as ElementQaProviderResult | null;
    if (!data || typeof data.answer !== 'string' || !data.answer.trim()) {
      throw new ElementQaProviderError('Element action response was malformed', 'ACTION_FAILED');
    }

    this.cachedModel = data.model ?? this.model;
    return { model: this.cachedModel, answer: data.answer };
  }
}
