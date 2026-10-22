import type { MonitoringAskErrorCode } from '@origami/contracts';

/**
 * Talks to the AI Router's dedicated POST /explain-monitoring-regression
 * route, never to a model server directly and never to /gateway — mirrors
 * HttpPageQaProvider's relationship to POST /answer-page-question exactly.
 * monitoring-ask-service.ts depends only on this interface.
 */
export interface MonitoringAskProvider {
  readonly model: string;
  answer(request: MonitoringAskProviderRequest, signal?: AbortSignal): Promise<MonitoringAskProviderResult>;
}

export interface MonitoringAskProviderRequest {
  question: string;
  contextText: string;
}

export interface MonitoringAskProviderResult {
  model: string;
  answer: string;
}

export class MonitoringAskProviderError extends Error {
  constructor(message: string, public readonly category: MonitoringAskErrorCode) {
    super(message);
    this.name = 'MonitoringAskProviderError';
  }
}

function envInt(name: string, defaultValue: number, minValue = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minValue) return defaultValue;
  return parsed;
}

export const AI_MONITORING_ASK_CLIENT_TIMEOUT_MS = envInt('AI_MONITORING_ASK_CLIENT_TIMEOUT_MS', 65_000);

export class HttpMonitoringAskProvider implements MonitoringAskProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private cachedModel: string | null = null;

  constructor(options: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = options.baseUrl ?? process.env.AI_ROUTER_URL ?? 'http://localhost:3102';
    this.timeoutMs = options.timeoutMs ?? AI_MONITORING_ASK_CLIENT_TIMEOUT_MS;
  }

  get model(): string {
    return this.cachedModel ?? process.env.AI_TEXT_MODEL ?? 'qwen2.5:7b';
  }

  async answer(request: MonitoringAskProviderRequest, signal?: AbortSignal): Promise<MonitoringAskProviderResult> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/explain-monitoring-regression`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: combinedSignal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new MonitoringAskProviderError(`Monitoring Q&A request timed out after ${this.timeoutMs}ms`, 'LLM_TIMEOUT');
      }
      if (signal?.aborted && !timeoutSignal.aborted) {
        throw new MonitoringAskProviderError('Monitoring Q&A request cancelled by caller', 'ASK_FAILED');
      }
      throw new MonitoringAskProviderError(error instanceof Error ? error.message : 'Monitoring Q&A provider unreachable', 'LLM_PROVIDER_UNAVAILABLE');
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      const message = typeof body.error === 'string' ? body.error : `Monitoring Q&A request failed: HTTP ${response.status}`;
      const category: MonitoringAskErrorCode = response.status === 504 ? 'LLM_TIMEOUT' : 'LLM_PROVIDER_UNAVAILABLE';
      throw new MonitoringAskProviderError(message, category);
    }

    const data = (await response.json().catch(() => null)) as MonitoringAskProviderResult | null;
    if (!data || typeof data.answer !== 'string' || !data.answer.trim()) {
      throw new MonitoringAskProviderError('Monitoring Q&A response was malformed', 'LLM_INVALID_RESPONSE');
    }

    this.cachedModel = data.model ?? this.model;
    return { model: this.cachedModel, answer: data.answer };
  }
}
