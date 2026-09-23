import type { RepositoryIssueConfidence } from '@origami/contracts';

/**
 * Talks to the AI Router's dedicated POST /analyze-repository-issue route
 * (services/ai-router/src/index.ts), never to a model server directly and
 * never to /gateway — mirrors HttpRerankerProvider's relationship to
 * POST /rerank exactly. The service layer (repository-issue-analysis-service.ts)
 * depends only on this interface, never on fetch/HTTP directly.
 */
export interface IssueAnalysisProvider {
  analyze(request: IssueAnalysisProviderRequest, signal?: AbortSignal): Promise<IssueAnalysisProviderResult>;
}

export interface EvidenceChunkInput {
  filePath: string;
  language: string;
  symbol: string;
  symbolType: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface IssueAnalysisProviderRequest {
  title: string;
  description: string;
  filePath?: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
  evidence: EvidenceChunkInput[];
}

export interface IssueAnalysisProviderResult {
  model: string;
  summary: string;
  rootCause: string;
  confidence: RepositoryIssueConfidence;
  affectedFiles: string[];
  affectedSymbols: string[];
  reasoning: string;
  recommendedFix: string;
  validationPlan: string;
}

export class IssueAnalysisProviderError extends Error {
  constructor(message: string, public readonly category: 'ANALYSIS_PROVIDER_UNAVAILABLE' | 'ANALYSIS_TIMEOUT' | 'ANALYSIS_FAILED') {
    super(message);
    this.name = 'IssueAnalysisProviderError';
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

/** Its own dedicated budget — never AI_MODEL_TIMEOUT_MS/AI_CODE_GENERATION_TIMEOUT_MS/AI_EMBED_TIMEOUT_MS/AI_RERANKER_TIMEOUT_MS. Kept slightly above the AI Router's own AI_ISSUE_ANALYSIS_TIMEOUT_MS default (60s) so the client never times out before the server-side call has a chance to. */
export const AI_ISSUE_ANALYSIS_CLIENT_TIMEOUT_MS = envInt('AI_ISSUE_ANALYSIS_CLIENT_TIMEOUT_MS', 65_000);

export class HttpIssueAnalysisProvider implements IssueAnalysisProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = options.baseUrl ?? process.env.AI_ROUTER_URL ?? 'http://localhost:3102';
    this.timeoutMs = options.timeoutMs ?? AI_ISSUE_ANALYSIS_CLIENT_TIMEOUT_MS;
  }

  async analyze(request: IssueAnalysisProviderRequest, signal?: AbortSignal): Promise<IssueAnalysisProviderResult> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/analyze-repository-issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: combinedSignal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new IssueAnalysisProviderError(`Issue analysis request timed out after ${this.timeoutMs}ms`, 'ANALYSIS_TIMEOUT');
      }
      if (signal?.aborted && !timeoutSignal.aborted) {
        throw new IssueAnalysisProviderError('Issue analysis request cancelled by caller', 'ANALYSIS_FAILED');
      }
      throw new IssueAnalysisProviderError(error instanceof Error ? error.message : 'Issue analysis provider unreachable', 'ANALYSIS_PROVIDER_UNAVAILABLE');
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown; errorCategory?: string };
      const message = typeof body.error === 'string' ? body.error : `Issue analysis request failed: HTTP ${response.status}`;
      const category = response.status === 504 ? 'ANALYSIS_TIMEOUT' : 'ANALYSIS_PROVIDER_UNAVAILABLE';
      throw new IssueAnalysisProviderError(message, category);
    }

    const data = (await response.json().catch(() => null)) as IssueAnalysisProviderResult | null;
    if (!data || typeof data.summary !== 'string' || typeof data.rootCause !== 'string') {
      throw new IssueAnalysisProviderError('Issue analysis response was malformed', 'ANALYSIS_FAILED');
    }
    return data;
  }
}
